import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { exportMobileErrorLog } from '@/lib/mobile-error-log';
import { getNativeConnectionFailure, subscribeNativeConnectionFailure } from './connectionFailure';
import { NativeApp } from './device';
import { getClientPlatform } from '@/lib/platform';

export const NativeConnectionFailureHint = () => {
  const failure = useSyncExternalStore(subscribeNativeConnectionFailure, getNativeConnectionFailure, () => null);
  const run = async (task: () => Promise<unknown>) => { try { await task(); } catch { toast.error('The device action could not be completed.'); } };
  return <div className="space-y-2 py-2">
    {failure && <p role="status" className="typography-small text-muted-foreground">Last native request: {failure.message}</p>}
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" variant="outline" onClick={() => void run(exportMobileErrorLog)}>Share redacted diagnostics</Button>
      {getClientPlatform() === 'ios' && <Button size="sm" variant="outline" onClick={() => void run(() => NativeApp.openSettings())}>Open iOS Settings</Button>}
    </div>
  </div>;
};
