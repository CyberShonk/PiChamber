import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useWorktreeStore } from '@/stores/useWorktreeStore';

const DISCOVERY_INTERVAL_MS = 60_000;
const DISCOVERY_CONCURRENCY = 2;

export const WorktreeDiscovery: React.FC = () => {
  const projects = useProjectsStore((state) => state.projects);
  const refreshProject = useWorktreeStore((state) => state.refreshProject);
  const { git } = useRuntimeAPIs();

  const projectPaths = React.useMemo(
    () => projects.map((project) => project.path).filter((path): path is string => Boolean(path)),
    [projects],
  );
  // Stable identity for the project set: `projectPaths` (and `git`, via the
  // runtime API context) can churn identity without content changing, which
  // used to re-run the mount refresh as a full discovery pass.
  const projectPathsKey = React.useMemo(
    () => [...projectPaths].sort().join('\0'),
    [projectPaths],
  );
  const runtimeKey = getRuntimeKey();

  // Background discovery never forces: `refreshProject`'s freshness window
  // (30 s) absorbs rapid focus/visibility toggles, and the HTTP caches absorb
  // the rest. Explicit mutation refreshes pass `{ force: true }` themselves.
  const refreshAll = React.useCallback(async () => {
    if (!git || projectPaths.length === 0) return;
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < projectPaths.length) {
        const path = projectPaths[nextIndex];
        nextIndex += 1;
        await refreshProject(path, git);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, projectPaths.length) }, () => worker()),
    );
  }, [git, projectPaths, refreshProject]);

  // Mount refresh only for a real project-set change, not array/object
  // identity churn. `refreshAll` is still in deps so a genuinely new closure
  // re-evaluates, but the key guard skips the redundant full pass.
  const lastDiscoveryKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const key = `${runtimeKey}\0${projectPathsKey}`;
    if (lastDiscoveryKeyRef.current === key) return;
    lastDiscoveryKeyRef.current = key;
    void refreshAll();
  }, [runtimeKey, projectPathsKey, refreshAll]);

  React.useEffect(() => {
    const handleFocus = () => { void refreshAll(); };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAll();
    }, DISCOVERY_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(interval);
    };
  }, [refreshAll]);

  return null;
};
