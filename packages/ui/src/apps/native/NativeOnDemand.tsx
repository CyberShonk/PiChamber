import React from 'react';
import { Button } from '@/components/ui/button';

/** Resolve native surface modules through committed state, including first open. */
export function NativeOnDemand<P extends object>({ load, componentProps, fallback }: {
  load: () => Promise<React.ComponentType<P>>;
  componentProps: P;
  fallback?: (state: React.ReactNode) => React.ReactNode;
}): React.ReactNode {
  const [result, setResult] = React.useState<{ component: React.ComponentType<P> | null; failed: boolean }>({ component: null, failed: false });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setResult({ component: null, failed: false });
    void load().then((component) => {
      if (active) setResult({ component, failed: false });
    }).catch(() => {
      if (active) setResult({ component: null, failed: true });
    });
    return () => { active = false; };
  }, [load, attempt]);
  if (result.component) return React.createElement(result.component, componentProps);
  const state = <div className="p-4" role="status">
    {result.failed ? <><p>Could not open this view.</p><Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry</Button></> : 'Loading…'}
  </div>;
  return fallback ? fallback(state) : state;
}
