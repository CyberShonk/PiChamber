import { afterAll, afterEach, expect, mock, test } from 'bun:test';
let platform = 'android';
let haptics = true;
let confirmed = false;
const feedback: string[] = [];
const pastes: string[] = [];
mock.module('@/lib/platform', () => ({ getClientPlatform: () => platform }));
mock.module('./preferences', () => ({ getNativePreferences: () => ({ haptics }) }));
mock.module('@capacitor/core', () => ({ registerPlugin: () => ({
  haptic: async ({ kind }: { kind: string }) => { feedback.push(kind); },
  confirmTerminalPaste: async ({ text }: { text: string }) => { pastes.push(text); return { confirmed }; },
}) }));
const { nativeHaptic, confirmNativeTerminalPaste } = await import('./device');
const originalNow = Date.now;
let now = 1000;
Date.now = () => now;
afterAll(() => { Date.now = originalNow; });
afterEach(() => { now += 100; platform = 'android'; haptics = true; confirmed = false; feedback.length = 0; pastes.length = 0; });

test('Android long-press feedback uses the native bridge and rate limits duplicate feedback', () => {
  nativeHaptic('impact'); nativeHaptic('impact');
  expect(feedback).toEqual(['impact']);
});
test('Android device preference can disable feedback', () => {
  haptics = false; nativeHaptic('impact'); expect(feedback).toEqual([]);
});
test('browser and desktop callers do not dispatch mobile feedback', () => {
  platform = 'web'; nativeHaptic(); platform = 'desktop'; nativeHaptic(); expect(feedback).toEqual([]);
});
test('iOS retains native feedback', () => {
  platform = 'ios'; nativeHaptic('success'); expect(feedback).toEqual(['success']);
});
test('Android single-line paste proceeds without a dialog', async () => {
  expect(await confirmNativeTerminalPaste('ls')).toBe(true); expect(pastes).toEqual([]);
});
test('Android multiline paste requires an explicit confirmation', async () => {
  expect(await confirmNativeTerminalPaste('ls\npwd')).toBe(false);
  confirmed = true;
  expect(await confirmNativeTerminalPaste('ls\npwd')).toBe(true);
  expect(pastes).toHaveLength(2);
});
test('hosted terminal paste retains its current behavior', async () => {
  platform = 'web'; expect(await confirmNativeTerminalPaste('ls\npwd')).toBe(true); expect(pastes).toEqual([]);
});
