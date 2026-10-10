import { useSyncExternalStore } from 'react';

type NativePreferences = { haptics: boolean; reduceMotion: boolean; offlineCache: boolean; dualScreen: boolean };
const defaults: NativePreferences = { haptics: true, reduceMotion: false, offlineCache: false, dualScreen: false };
const key = 'pichamber.native.preferences.v1';
let current: NativePreferences | undefined;
const listeners = new Set<() => void>();
export const getNativePreferences = (): NativePreferences => {
  if (current) return current;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    const value = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    current = { ...defaults };
    for (const name of Object.keys(defaults) as Array<keyof NativePreferences>) {
      if (typeof value[name] === 'boolean') current[name] = value[name];
    }
  } catch { current = { ...defaults }; }
  return current;
};
export const setNativePreference = <K extends keyof NativePreferences>(name: K, value: NativePreferences[K]): void => {
  current = { ...getNativePreferences(), [name]: value };
  try { localStorage.setItem(key, JSON.stringify(current)); } catch { /* Works for this launch if storage is unavailable. */ }
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useNativePreferences = () => useSyncExternalStore(subscribe, getNativePreferences, () => defaults);
