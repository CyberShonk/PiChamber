import { expect, test } from 'bun:test';
const values = new Map<string, string>();
values.set('pichamber.native.preferences.v1', JSON.stringify({ haptics: false, reduceMotion: true, offlineCache: true, dualScreen: true }));
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
const { getNativePreferences, setNativePreference } = await import('./preferences');

test('existing device choices and explicit companion preference survive', () => {
  expect(getNativePreferences()).toEqual({ haptics: false, reduceMotion: true, offlineCache: true, dualScreen: true });
});
test('saving device preferences preserves the companion choice', () => {
  setNativePreference('haptics', true);
  expect(JSON.parse(values.get('pichamber.native.preferences.v1')!)).toEqual({ haptics: true, reduceMotion: true, offlineCache: true, dualScreen: true });
  expect(values.size).toBe(1);
});
