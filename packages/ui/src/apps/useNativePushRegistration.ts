import React from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getClientPlatform } from '@/lib/platform';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { setNativePushStatus } from './native/pushStatus';

const getApnsEnvironment = (): 'sandbox' | 'production' | undefined => {
  const env = (window as typeof window & { __PICHAMBER_APNS_ENV__?: string }).__PICHAMBER_APNS_ENV__;
  return env === 'development' ? 'sandbox' : env === 'production' ? 'production' : undefined;
};
const subscribeRuntime = (listener: () => void) => subscribeRuntimeEndpointChanged(listener);

/** Device token registration is bound to a specific runtime. Late results cannot mark a new host ready. */
export const useNativePushRegistration = ({ enabled }: { enabled: boolean }): void => {
  const notificationsEnabled = useUIStore((state) => state.nativeNotificationsEnabled);
  const runtimeKey = React.useSyncExternalStore(subscribeRuntime, getRuntimeKey, () => '');
  const [retry, setRetry] = React.useState(0);
  const lastRegistration = React.useRef<{ token: string; runtimeKey: string; unregister: () => Promise<unknown> } | null>(null);
  React.useEffect(() => {
    const refresh = () => setRetry((value) => value + 1);
    window.addEventListener('pichamber:native-push-retry', refresh);
    // Returning from Settings refreshes permission, without another permission prompt.
    window.addEventListener('oc:app-resumed', refresh);
    return () => {
      window.removeEventListener('pichamber:native-push-retry', refresh);
      window.removeEventListener('oc:app-resumed', refresh);
    };
  }, []);

  React.useEffect(() => {
    if (!enabled || !notificationsEnabled || !['ios', 'android'].includes(getClientPlatform())) {
      setNativePushStatus({ registration: notificationsEnabled ? 'disconnected' : 'disabled' });
      return;
    }
    let disposed = false;
    let registering = false;
    let pendingToken: string | null = null;
    const handles: Array<{ remove(): Promise<void> }> = [];
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => !disposed && getRuntimeKey() === runtimeKey;
    const fail = (error: string) => { if (isCurrent()) setNativePushStatus({ registration: 'failed', error }); };
    setNativePushStatus({ registration: 'registering' });
    void import('@capacitor/push-notifications').then(async ({ PushNotifications }) => {
      const permission = await PushNotifications.checkPermissions();
      if (!isCurrent()) return;
      const requested = permission.receive === 'prompt' ? await PushNotifications.requestPermissions() : permission;
      if (!isCurrent()) return;
      setNativePushStatus({ permission: requested.receive === 'granted' ? 'granted' : requested.receive === 'denied' ? 'denied' : 'prompt', registration: 'registering' });
      if (requested.receive !== 'granted') { fail('Enable notifications in device Settings.'); return; }
      const registerToken = async (token: string, attempt = 0): Promise<void> => {
        if (!isCurrent()) return;
        if (registering) { pendingToken = token; return; }
        const push = getRegisteredRuntimeAPIs()?.push;
        if (!push?.registerApnsToken) { fail('This host does not support device notifications.'); return; }
        registering = true;
        try {
          const result = await push.registerApnsToken({ token, platform: getClientPlatform(), environment: getApnsEnvironment() });
          if (!isCurrent()) return;
          if (!result?.ok) throw new Error('Registration failed');
          if (timeout) clearTimeout(timeout);
          lastRegistration.current = { token, runtimeKey, unregister: () => push.unregisterApnsToken({ token }) };
          setNativePushStatus({ registration: 'registered' });
        } catch {
          fail('The host could not register this device. Retry after checking the connection.');
          if (isCurrent() && attempt < 2) retryTimer = setTimeout(() => void registerToken(token, attempt + 1), 1000 * 2 ** attempt);
        } finally {
          registering = false;
          if (pendingToken && isCurrent()) { const next = pendingToken; pendingToken = null; void registerToken(next); }
        }
      };
      const registration = await PushNotifications.addListener('registration', (token) => { void registerToken(token.value); });
      if (!isCurrent()) { void registration.remove(); return; }
      handles.push(registration);
      const error = await PushNotifications.addListener('registrationError', () => fail('iOS or Android could not register for push notifications.'));
      if (!isCurrent()) { void error.remove(); return; }
      handles.push(error);
      timeout = setTimeout(() => fail('Device registration timed out. Retry when online.'), 15000);
      await PushNotifications.register();
    }).catch(() => fail('Device notification registration failed.'));
    return () => {
      disposed = true;
      handles.forEach((handle) => { void handle.remove(); });
      if (retryTimer) clearTimeout(retryTimer);
      if (timeout) clearTimeout(timeout);
    };
  }, [enabled, notificationsEnabled, runtimeKey, retry]);

  React.useEffect(() => {
    if (notificationsEnabled) return;
    const previous = lastRegistration.current;
    lastRegistration.current = null;
    // Do not route the old token removal to a newly selected host.
    if (previous?.runtimeKey === getRuntimeKey()) void previous.unregister().catch(() => undefined);
    if (['ios', 'android'].includes(getClientPlatform())) {
      void import('@capacitor/push-notifications').then(({ PushNotifications }) => PushNotifications.unregister()).catch(() => undefined);
    }
  }, [notificationsEnabled]);
};
