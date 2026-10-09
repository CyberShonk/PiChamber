import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { getClientPlatform } from '@/lib/platform';
import { NativeApp } from './device';
import { useNativePushStatus, retryNativePushRegistration, setNativePushStatus } from './pushStatus';

const registrationLabels = { disconnected: 'Connect to a host to register this device.', disabled: 'Device notifications are off.', registering: 'Registering this device…', registered: 'This device is registered with the connected host.', failed: 'Device registration failed.' };
export const NativeNotificationControls = () => {
  const status = useNativePushStatus();
  const [busy, setBusy] = useState(false);
  const ios = getClientPlatform() === 'ios';
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void import('@capacitor/push-notifications').then(({ PushNotifications }) => PushNotifications.checkPermissions()).then(({ receive }) => {
        if (!disposed) setNativePushStatus({ permission: receive === 'granted' ? 'granted' : receive === 'denied' ? 'denied' : 'prompt' });
      }).catch(() => { if (!disposed) setNativePushStatus({ permission: 'unknown' }); });
    };
    refresh();
    window.addEventListener('oc:app-resumed', refresh);
    return () => { disposed = true; window.removeEventListener('oc:app-resumed', refresh); };
  }, []);
  const action = async (task: () => Promise<void>) => {
    setBusy(true);
    try { await task(); } catch { toast.error('The device action could not be completed. Check notification permission in Settings.'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 pt-2" data-settings-item="notifications.native">
    <p role="status" className="typography-meta text-muted-foreground">Permission: {status.permission}. {status.error ?? registrationLabels[status.registration]}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={retryNativePushRegistration} disabled={busy || (status.registration === 'registering' || status.registration === 'disabled')}>Retry registration</Button>
      {ios && <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => NativeApp.openSettings())}>Open iOS Settings</Button>
        <Button size="sm" variant="outline" disabled={busy || status.permission !== 'granted'} onClick={() => void action(async () => { await NativeApp.testNotification(); toast.info('Test scheduled. Background the app within five seconds to see it.'); })}>Test device notification</Button>
      </>}
    </div>
    <p className="typography-meta text-muted-foreground">The device test checks iOS delivery. Remote delivery also requires push configured on the connected host.</p>
  </div>;
};
