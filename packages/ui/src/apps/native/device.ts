import { registerPlugin } from '@capacitor/core';
import { getClientPlatform } from '@/lib/platform';
import { getNativePreferences } from './preferences';

interface NativeAppBridge {
  setAppearance(options: { mode: 'system' | 'dark' | 'light' }): Promise<void>;
  confirmTerminalPaste(options: { text: string }): Promise<{ confirmed: boolean }>;
  haptic(options: { kind: 'selection' | 'impact' | 'success' | 'error' }): Promise<void>;
  openSettings(): Promise<void>;
  testNotification(): Promise<void>;
  shareFile(options: { filename: string; base64: string }): Promise<{ completed: boolean }>;
}
export const NativeApp = registerPlugin<NativeAppBridge>('NativeApp');
let lastHapticAt = 0;
/** A single, rate-limited feedback per user action; never tied to streamed tokens. */
export const nativeHaptic = (kind: 'selection' | 'impact' | 'success' | 'error' = 'selection'): void => {
  if (!['ios', 'android'].includes(getClientPlatform()) || !getNativePreferences().haptics) return;
  const now = Date.now();
  if (now - lastHapticAt < 80) return;
  lastHapticAt = now;
  void NativeApp.haptic({ kind }).catch(() => undefined);
};

export const confirmNativeTerminalPaste = async (text: string): Promise<boolean> => {
  if (!['ios', 'android'].includes(getClientPlatform()) || !/[\r\n]/.test(text)) return true;
  const result = await NativeApp.confirmTerminalPaste({ text });
  return result.confirmed;
};
