import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { CompanionFrame } from './companionDocument';
import { allowedCompanionAction, type CompanionAction } from './companionModel';
export type CompanionState = { status: 'off' | 'active' | 'keyboard' | 'paused' | 'unavailable' | 'error'; displayName?: string; displayCount: number };
interface CompanionBridge {
  getState(): Promise<CompanionState>;
  setEnabled(options: { enabled: boolean; keyboardVisible?: boolean }): Promise<CompanionState>;
  setKeyboardVisible(options: { visible: boolean }): Promise<void>;
  chooseDisplay(): Promise<CompanionState>;
  publish(options: { snapshot: CompanionFrame }): Promise<void>;
  addListener(event: 'state', callback: (state: CompanionState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'action', callback: (action: CompanionAction) => void): Promise<PluginListenerHandle>;
}
export const AndroidCompanion = registerPlugin<CompanionBridge>('AndroidCompanion');
// Serialize native mutations across remounts: an old cleanup cannot dismiss a new owner.
let nativeQueue: Promise<unknown> = Promise.resolve();
const enqueue = (task: () => Promise<unknown>) => {
  const next = nativeQueue.catch(() => undefined).then(task);
  nativeQueue = next;
  return next;
};

/** Latest-only, one in flight, at most four snapshot publications per second. */
export const createCompanionPublisher = (
  publish: (snapshot: CompanionFrame) => Promise<void>,
  onError: () => void,
  delay = 250,
) => {
  let disposed = false;
  let pending: CompanionFrame | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let lastSent = '';
  const schedule = () => {
    if (disposed || sending || timer !== undefined || !pending) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  };
  const flush = async () => {
    const snapshot = pending;
    pending = null;
    if (disposed || !snapshot) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSent) { schedule(); return; }
    sending = true;
    try { await publish(snapshot); lastSent = serialized; }
    catch { if (!disposed) onError(); }
    finally { sending = false; schedule(); }
  };
  return {
    update(snapshot: CompanionFrame) { if (disposed) return; pending = snapshot; schedule(); },
    dispose() { disposed = true; pending = null; if (timer !== undefined) clearTimeout(timer); },
  };
};

export const startCompanion = (onAction: (action: CompanionAction) => void, onError: () => void, keyboardVisible = false) => {
  let disposed = false;
  let listener: PluginListenerHandle | undefined;
  const ready = enqueue(async () => {
    if (disposed) return;
    listener = await AndroidCompanion.addListener('action', (action) => { if (!disposed && allowedCompanionAction(action)) onAction(action); });
    if (!disposed) await AndroidCompanion.setEnabled({ enabled: true, keyboardVisible });
  });
  void ready.catch(() => { if (!disposed) onError(); });
  const publisher = createCompanionPublisher(async (snapshot) => {
    await ready;
    await enqueue(async () => { if (!disposed) await AndroidCompanion.publish({ snapshot }); });
  }, onError);
  const keyboard = (visible: boolean) => {
    void enqueue(async () => { if (!disposed) await AndroidCompanion.setKeyboardVisible({ visible }); }).catch(() => { if (!disposed) onError(); });
  };
  return {
    update: publisher.update,
    keyboard,
    dispose() {
      disposed = true;
      publisher.dispose();
      void enqueue(async () => {
        try { await listener?.remove(); }
        finally { await AndroidCompanion.setEnabled({ enabled: false }); }
      }).catch(onError);
    },
  };
};
