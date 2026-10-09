import { beforeEach, describe, expect, mock, test } from 'bun:test';
let runtimeKey = 'host-a';
let undo: (() => void) | undefined;
const failures: string[] = [];
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));
mock.module('@/components/ui', () => ({ toast: {
  success: (_text: string, options: { action: { onClick: () => void } }) => { undo = options.action.onClick; },
  error: (text: string) => failures.push(text),
  info: () => undefined,
} }));
mock.module('./device', () => ({ nativeHaptic: () => undefined }));
const { showNativeArchiveUndo } = await import('./archiveUndo');
const flush = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
beforeEach(() => { runtimeKey = 'host-a'; undo = undefined; failures.length = 0; });
describe('native archive undo', () => {
  test('restores only successful archived IDs, once', async () => {
    const restored: string[] = [];
    showNativeArchiveUndo(['a', 'b'], runtimeKey, async (id) => { restored.push(id); return true; });
    undo?.(); undo?.(); await flush();
    expect(restored).toEqual(['a', 'b']);
  });
  test('host switches invalidate undo before any request is sent', async () => {
    let calls = 0;
    const restore = async () => { calls++; return true; };
    showNativeArchiveUndo(['a'], runtimeKey, restore);
    runtimeKey = 'host-b'; undo?.(); await flush();
    expect(calls).toBe(0);
  });
  test('partial restore failure stays visible', async () => {
    showNativeArchiveUndo(['a', 'b'], runtimeKey, async (id) => id === 'a');
    undo?.(); await flush();
    expect(failures).toEqual(['One session could not be restored.']);
  });
  test('a late archive on another host cannot offer a misleading undo', () => {
    runtimeKey = 'host-b'; showNativeArchiveUndo(['a'], 'host-a', async () => true);
    expect(undo).toBeUndefined();
  });
});
