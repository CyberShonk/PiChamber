import { useEffect, useState } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { AndroidCompanion, type CompanionState } from './androidCompanion';
import { setNativePreference, useNativePreferences } from './preferences';

const labels: Record<CompanionState['status'], string> = {
  off: 'Second-screen companion is off.', active: 'Second-screen companion is active.',
  keyboard: 'Companion hidden while the keyboard is open.', paused: 'Companion paused while the app is in the background.',
  unavailable: 'No eligible second display. Turn on the Thor’s bottom display and retry.',
  error: 'Android could not open the second display. Check the display is available and retry.',
};
export const AndroidCompanionSettings = () => {
  const { dualScreen } = useNativePreferences();
  const [state, setState] = useState<CompanionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let listener: PluginListenerHandle | undefined;
    const refresh = async () => {
      try {
        listener = await AndroidCompanion.addListener('state', (next) => { if (!disposed) setState(next); });
        if (disposed) { await listener.remove(); return; }
        const next = await AndroidCompanion.getState();
        if (!disposed) setState(next);
      } catch { if (!disposed) setFailed(true); }
    };
    void refresh();
    return () => { disposed = true; void listener?.remove(); };
  }, []);
  const retry = async () => {
    setBusy(true); setFailed(false);
    try { setState(await AndroidCompanion.chooseDisplay()); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <>
    <SettingsCheckboxRow settingsItem="appearance.android-dual-screen" checked={dualScreen} onChange={(checked) => { setFailed(false); setNativePreference('dualScreen', checked); }} label="Second-screen companion" ariaLabel="Second-screen companion" info="Android only. Workspace status, changed files and touch shortcuts on the other display. Chat, terminal and text input stay on the main screen. The companion hides while the keyboard is open and when the app is backgrounded. No extra host connection." />
    <p role="status" className="typography-meta text-muted-foreground">{failed ? 'The companion bridge is unavailable. Install an Android build containing this feature.' : state ? labels[state.status] + (state.displayName ? ` ${state.displayName}` : '') : 'Checking second-display support…'}</p>
    {dualScreen && <Button size="sm" variant="outline" disabled={busy} onClick={() => void retry()}>{state && state.displayCount > 1 ? 'Choose display' : 'Retry display'}</Button>}
  </>;
};
