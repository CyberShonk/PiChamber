import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { GitStatus } from '@/lib/api/types';

export type CompanionState = { status: 'off' | 'active' | 'keyboard' | 'paused' | 'unavailable' | 'error'; displayName?: string; displayCount: number };
export type CompanionSnapshot = {
  scope: number;
  workspaceScope: number;
  workspace: string;
  branch: string;
  summary: string;
  files: Array<{ label: string; path: string; staged: boolean }>;
  colors: { background: string; foreground: string; muted: string; border: string; selection: string; selectionForeground: string };
};
type CompanionAction = { scope: number; type: 'changes' | 'files' | 'settings' | 'file'; index?: number };
interface CompanionBridge {
  getState(): Promise<CompanionState>;
  setEnabled(options: { enabled: boolean; keyboardVisible?: boolean }): Promise<CompanionState>;
  setKeyboardVisible(options: { visible: boolean }): Promise<void>;
  chooseDisplay(): Promise<CompanionState>;
  publish(options: { snapshot: Omit<CompanionSnapshot, 'files'> & { files: Array<{ label: string }> } }): Promise<void>;
  addListener(event: 'state', callback: (state: CompanionState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'action', callback: (action: CompanionAction) => void): Promise<PluginListenerHandle>;
}
export const AndroidCompanion = registerPlugin<CompanionBridge>('AndroidCompanion');

/** Preserve Git's paths for navigation; only presentation labels are shortened. */
export const companionGitSummary = (status: GitStatus | null, isGitRepo: boolean | null) => {
  if (!status) return { branch: '', summary: isGitRepo === false ? 'This workspace is not a Git repository.' : 'Open Changes to load Git status.', files: [] };
  const files = status.files.slice(0, 50).map((file) => ({
    label: file.path.length > 240 ? '…' + file.path.slice(-239) : file.path,
    path: file.path,
    staged: Boolean(file.index.trim() && file.index.trim() !== '?' && !file.working_dir.trim()),
  }));
  const count = status.files.length;
  return {
    branch: status.current ?? '',
    summary: count === 0 ? 'Working tree clean.' : `${count} ${count === 1 ? 'file' : 'files'} changed.${count > 50 ? ' Showing the first 50.' : ''}`,
    files,
  };
};

// Serialize native mutations across remounts: an old cleanup cannot dismiss a new owner.
let nativeQueue: Promise<unknown> = Promise.resolve();
const enqueue = (task: () => Promise<unknown>) => {
  const next = nativeQueue.catch(() => undefined).then(task);
  nativeQueue = next;
  return next;
};

/** Latest-only, one in flight, at most four snapshot publications per second. */
export const createCompanionPublisher = (
  publish: (snapshot: CompanionSnapshot) => Promise<void>,
  onError: () => void,
  delay = 250,
) => {
  let disposed = false;
  let pending: CompanionSnapshot | null = null;
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
    update(snapshot: CompanionSnapshot) { if (disposed) return; pending = snapshot; schedule(); },
    dispose() { disposed = true; pending = null; if (timer !== undefined) clearTimeout(timer); },
  };
};

export const startCompanion = (onAction: (action: CompanionAction) => void, onError: () => void, keyboardVisible = false) => {
  let disposed = false;
  let listener: PluginListenerHandle | undefined;
  const ready = enqueue(async () => {
    if (disposed) return;
    listener = await AndroidCompanion.addListener('action', (action) => { if (!disposed) onAction(action); });
    if (!disposed) await AndroidCompanion.setEnabled({ enabled: true, keyboardVisible });
  });
  void ready.catch(() => { if (!disposed) onError(); });
  const publisher = createCompanionPublisher(async (snapshot) => {
    await ready;
    await enqueue(async () => { if (!disposed) await AndroidCompanion.publish({ snapshot: { ...snapshot, files: snapshot.files.map(({ label }) => ({ label })) } }); });
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
