import { useSyncExternalStore } from 'react';

type NativePushStatus = { permission: 'unknown' | 'prompt' | 'denied' | 'granted'; registration: 'disconnected' | 'disabled' | 'registering' | 'registered' | 'failed'; error?: string };
let status: NativePushStatus = { permission: 'unknown', registration: 'disconnected' };
const listeners = new Set<() => void>();
export const setNativePushStatus = (next: Partial<NativePushStatus>): void => {
  const updated = { ...status, ...next };
  if ('registration' in next && !('error' in next)) updated.error = undefined;
  if (updated.permission === status.permission && updated.registration === status.registration && updated.error === status.error) return;
  status = updated;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => status;
export const useNativePushStatus = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
export const retryNativePushRegistration = () => window.dispatchEvent(new Event('pichamber:native-push-retry'));
