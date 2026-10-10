import { expect, test } from 'bun:test';
const values = new Map<string, string>();
values.set('pichamber.native.preferences.v1', JSON.stringify({ haptics: false, reduceMotion: true, offlineCache: true }));
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
const { getNativePreferences, setNativePreference } = await import('./preferences');

test('existing device choices survive and the companion starts disabled', () => {
  expect(getNativePreferences()).toEqual({ haptics: false, reduceMotion: true, offlineCache: true, dualScreen: false });
});
test('companion toggling persists separately from host settings', () => {
  setNativePreference('dualScreen', true);
  expect(getNativePreferences().dualScreen).toBe(true);
  const saved = JSON.parse(values.get('pichamber.native.preferences.v1')!);
  expect(saved).toEqual({ haptics: false, reduceMotion: true, offlineCache: true, dualScreen: true });
  expect(values.size).toBe(1);
  setNativePreference('dualScreen', false);
  expect(getNativePreferences().dualScreen).toBe(false);
});
