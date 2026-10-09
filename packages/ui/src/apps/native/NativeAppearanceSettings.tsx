import { SettingsSection, SettingsCheckboxRow, SETTINGS_OPTION_STACK_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { isCapacitorApp, getClientPlatform } from '@/lib/platform';
import { useNativePreferences, setNativePreference } from './preferences';
import { clearOfflineCopies } from './offlineCopies';
import { toast } from '@/components/ui';
import { nativeHaptic } from './device';
import preview from './red-carbon-preview.png';

export const NativeAppearanceSettings = () => {
  const preferences = useNativePreferences();
  const { currentTheme, setTheme } = useThemeSystem();
  const native = isCapacitorApp();
  if (!native) return null;
  return (
    <SettingsSection title="Device appearance and feedback" settingsItem="appearance.native" info="These preferences stay on this device. Red Carbon uses matte graphite and red gasket trim.">
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <div className="flex items-center gap-3 pb-3">
          <img src={preview} width={72} height={72} alt="Red Carbon supplied matte graphite and red gasket preview" className="size-18 shrink-0 rounded-md" loading="lazy" />
          <Button variant="outline" size="sm" aria-pressed={currentTheme.metadata.id === 'red-carbon-dark'} onClick={() => setTheme('red-carbon-dark')}>Use Red Carbon</Button>
        </div>
        {getClientPlatform() === 'ios' && <SettingsCheckboxRow settingsItem="appearance.native-haptics" checked={preferences.haptics} onChange={(checked) => { setNativePreference('haptics', checked); if (checked) nativeHaptic(); }} label="Haptic feedback" ariaLabel="Haptic feedback" info="Light feedback for session selection, drawer changes and sending. Respects the device's haptic settings." />}
        <SettingsCheckboxRow settingsItem="appearance.offline-copies" checked={preferences.offlineCache} onChange={(checked) => { setNativePreference('offlineCache', checked); if (!checked) void clearOfflineCopies().catch(() => toast.error('Offline copies could not be deleted. They are hidden while offline copies are disabled.')); }} label="Allow offline copies" ariaLabel="Allow offline copies" info="Save explicit read-only snapshots from Quick navigation. Up to three copies, 600 KB each. Disabling removes copies. They can include private conversation text." />
        <Button data-settings-item="appearance.clear-offline-copies" variant="outline" size="sm" onClick={() => void clearOfflineCopies().catch(() => toast.error('Offline copies could not be cleared.'))}>Clear offline copies</Button>
        <SettingsCheckboxRow settingsItem="appearance.native-reduce-motion" checked={preferences.reduceMotion} onChange={(checked) => setNativePreference('reduceMotion', checked)} label="Reduce motion" ariaLabel="Reduce motion" info="Shortens native app transitions. iOS Reduce Motion is also respected for keyboard movement." />
      </div>
    </SettingsSection>
  );
};
