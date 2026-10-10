import { expect, mock, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
const nativeCalls: string[] = [];
const published: Array<{ files: Array<Record<string, unknown>> }> = [];
let actions: ((action: unknown) => void) | undefined;
let holdEnable: (() => void) | undefined;
let enableBlocked = false;
const bridge = {
  addListener: async (_event: string, callback: (action: unknown) => void) => {
    actions = callback;
    return { remove: async () => { nativeCalls.push('remove'); } };
  },
  setEnabled: async ({ enabled }: { enabled: boolean }) => {
    nativeCalls.push(enabled ? 'on' : 'off');
    if (enabled && enableBlocked) await new Promise<void>((resolve) => { holdEnable = resolve; });
    return { status: enabled ? 'active' : 'off', displayCount: 1 };
  },
  setKeyboardVisible: async ({ visible }: { visible: boolean }) => { nativeCalls.push(`keyboard:${visible}`); },
  publish: async ({ snapshot }: { snapshot: { files: Array<Record<string, unknown>> } }) => { nativeCalls.push('publish'); published.push(snapshot); },
};
mock.module('@capacitor/core', () => ({ registerPlugin: () => bridge }));
const { companionGitSummary, createCompanionPublisher, startCompanion } = await import('./androidCompanion');
const pause = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const sample = (scope = 1) => ({ scope, workspaceScope: 1, workspace: 'workspace', branch: '', summary: '', files: [], colors: { background: '#000000', foreground: '#FFFFFF', muted: '#CCCCCC', border: '#444444', selection: '#555555', selectionForeground: '#FFFFFF' } });
const status = (files: GitStatus['files']): GitStatus => ({ current: 'work', tracking: null, ahead: 0, behind: 0, files, isClean: files.length === 0 });

test('unknown Git state is distinct from a clean working tree', () => {
  expect(companionGitSummary(null, null).summary).toContain('load Git status');
  expect(companionGitSummary(null, false).summary).toContain('not a Git');
  expect(companionGitSummary(status([]), true).summary).toContain('clean');
});
test('large workspace output is bounded and preserves exact diff paths', () => {
  const files = Array.from({ length: 10000 }, (_, i) => ({ path: `nested/${'x'.repeat(300)}/${i}`, index: 'M', working_dir: ' ' }));
  const result = companionGitSummary(status(files), true);
  expect(result.files).toHaveLength(50);
  expect(result.summary).toContain('10000 files');
  expect(result.summary).toContain('first 50');
  expect(result.files[0].label.length).toBe(240);
  expect(result.files[0].path).toBe(files[0].path);
  expect(result.files[0].staged).toBe(true);
});
test('mixed staged/working changes open the working diff', () => {
  expect(companionGitSummary(status([{ path: 'a', index: 'M', working_dir: 'M' }]), true).files[0].staged).toBe(false);
});
test('burst publications coalesce to latest and identical snapshots do no bridge work', async () => {
  const sent: number[] = [];
  const publisher = createCompanionPublisher(async (snapshot) => { sent.push(snapshot.scope); }, () => { throw new Error('unexpected'); }, 2);
  for (let i = 0; i < 1000; i++) publisher.update(sample(i));
  await pause();
  expect(sent).toEqual([999]);
  publisher.update(sample(999));
  await pause();
  expect(sent).toEqual([999]);
  publisher.dispose();
});
test('a slow native bridge permits only one publication in flight', async () => {
  const sent: number[] = [];
  let resolve!: () => void;
  const first = new Promise<void>((done) => { resolve = done; });
  const publisher = createCompanionPublisher(async (snapshot) => { sent.push(snapshot.scope); if (sent.length === 1) await first; }, () => undefined, 2);
  publisher.update(sample(1)); await pause();
  publisher.update(sample(2)); publisher.update(sample(3)); await pause();
  expect(sent).toEqual([1]);
  resolve(); await pause();
  expect(sent).toEqual([1, 3]);
  publisher.dispose();
});
test('disposing drops pending snapshots and late failures', async () => {
  let sends = 0; let errors = 0;
  const publisher = createCompanionPublisher(async () => { sends++; }, () => { errors++; }, 2);
  publisher.update(sample()); publisher.dispose(); await pause();
  expect(sends).toBe(0); expect(errors).toBe(0);
});
test('failure remains visible and a later update can retry', async () => {
  let sends = 0; let errors = 0;
  const publisher = createCompanionPublisher(async () => { if (++sends === 1) throw new Error('bridge failed'); }, () => { errors++; }, 2);
  publisher.update(sample()); await pause();
  publisher.update(sample()); await pause();
  expect(sends).toBe(2); expect(errors).toBe(1);
  publisher.dispose();
});
test('remount waits for old disable, removes listeners, and ignores dismissed actions', async () => {
  nativeCalls.length = 0; enableBlocked = true;
  let taps = 0;
  const first = startCompanion(() => { taps++; }, () => undefined);
  await pause();
  const oldCallback = actions;
  first.dispose();
  const second = startCompanion(() => { taps++; }, () => undefined);
  second.keyboard(true);
  oldCallback?.({ type: 'changes', scope: 1 });
  expect(taps).toBe(0);
  enableBlocked = false; holdEnable?.();
  await pause();
  expect(nativeCalls).toEqual(['on', 'remove', 'off', 'on', 'keyboard:true']);
  second.dispose(); await pause();
  expect(nativeCalls.slice(-2)).toEqual(['remove', 'off']);
});


test('the native display receives labels only, never full navigation paths', async () => {
  published.length = 0;
  const owner = startCompanion(() => undefined, () => undefined);
  owner.update({ ...sample(), files: [{ label: 'a.ts', path: '/private/workspace/a.ts', staged: true }] });
  await pause(300);
  expect(published).toHaveLength(1);
  expect(published[0].files).toEqual([{ label: 'a.ts' }]);
  owner.dispose(); await pause();
});
