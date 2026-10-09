import { useSyncExternalStore } from 'react';
import { useNotificationStore, type Notification } from '@/sync/notification-store';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type NativeAttentionEvent = { runtimeKey: string; session: string; time: number; type: 'turn-complete' | 'error' };
let events: readonly NativeAttentionEvent[] = [];
const listeners = new Set<() => void>();
const signature = (item: Notification) => JSON.stringify([item.session, item.time, item.type]);
/** Record only newly observed events, bound to their runtime. Never infer activity from history. */
export const startNativeAttentionTracking = (): (() => void) => {
  let seen = new Set(useNotificationStore.getState().list.map(signature));
  const endpoint = subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey !== detail.previousRuntimeKey) seen = new Set(useNotificationStore.getState().list.map(signature));
  });
  const unsubscribe = useNotificationStore.subscribe((state) => {
    const nextSeen = new Set<string>();
    const added: NativeAttentionEvent[] = [];
    const runtimeKey = getRuntimeKey();
    for (const item of state.list) {
      const key = signature(item);
      nextSeen.add(key);
      if (!seen.has(key) && !item.viewed && item.session) added.push({ runtimeKey, session: item.session, time: item.time, type: item.type });
    }
    seen = nextSeen;
    if (added.length === 0) return;
    events = [...events, ...added].slice(-200);
    listeners.forEach((listener) => listener());
  });
  return () => { endpoint(); unsubscribe(); };
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => events;
export const useNativeAttentionEvents = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
