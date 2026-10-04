import React from 'react';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { runBackgroundNetworkTask } from '@/lib/background-network';

type Project = { id: string; path: string; normalizedPath: string };
const ROOT_BRANCH_TTL_MS = 5 * 60_000;

type Args = {
  enabled?: boolean;
  normalizedProjects: Project[];
  gitRepoStatus: Map<string, { isGitRepo: boolean | null; branch: string | null }>;
  setProjectRepoStatus: React.Dispatch<React.SetStateAction<Map<string, boolean | null>>>;
  setProjectRootBranches: React.Dispatch<React.SetStateAction<Map<string, string>>>;
};

export const useProjectRepoStatus = (args: Args): void => {
  const {
    normalizedProjects,
    enabled = true,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  } = args;

  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);

  // Stable identity for the project set: `normalizedProjects` is rebuilt by
  // the parent memo whenever the projects array churns, which used to
  // re-fire `ensureStatus` per project (one `/check` + `/status` each) with
  // no content change.
  const projectPathsKey = React.useMemo(
    () => normalizedProjects.map((project) => project.normalizedPath).slice().sort().join('\0'),
    [normalizedProjects],
  );
  const lastEnsureKeyRef = React.useRef<string | null>(null);

  // Derive repo status from centralized Git store
  React.useEffect(() => {
    if (!enabled || !git || normalizedProjects.length === 0) {
      lastEnsureKeyRef.current = null;
      setProjectRepoStatus(new Map());
      return;
    }
    // Runtime switches change `getRuntimeKey()` and rebuild `git`; either
    // must re-run even when the project set is unchanged.
    const key = `${getRuntimeKey()}\0${projectPathsKey}`;
    if (lastEnsureKeyRef.current === key) return;
    lastEnsureKeyRef.current = key;

    // Trigger ensureStatus for each project to populate store
    normalizedProjects.forEach((project) => {
      void runBackgroundNetworkTask(() => ensureStatus(project.normalizedPath, git));
    });
  }, [enabled, normalizedProjects, projectPathsKey, git, ensureStatus, setProjectRepoStatus]);

  // Read isGitRepo from the store-populated state. Guarded so parent array
  // identity churn alone does not publish a new Map (and re-render) with
  // identical content.
  const lastRepoStatusKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!enabled) {
      lastRepoStatusKeyRef.current = null;
      return;
    }
    const next = new Map<string, boolean | null>();
    normalizedProjects.forEach((project) => {
      next.set(project.id, gitRepoStatus.get(project.normalizedPath)?.isGitRepo ?? null);
    });
    const key = normalizedProjects.map((project) => `${project.id}:${String(next.get(project.id))}`).join('|');
    if (lastRepoStatusKeyRef.current === key) return;
    lastRepoStatusKeyRef.current = key;
    setProjectRepoStatus(next);
  }, [enabled, normalizedProjects, projectPathsKey, gitRepoStatus, setProjectRepoStatus]);

  const projectGitBranchesKey = React.useMemo(() => {
    return normalizedProjects
      .map((project) => {
        const branch = gitRepoStatus.get(project.normalizedPath)?.branch ?? '';
        return `${project.id}:${branch}`;
      })
      .join('|');
  }, [normalizedProjects, gitRepoStatus]);

  // Tracks the project path + input branch we last resolved against, per project.
  // Used to resolve `getRootBranch` only for projects that are new or whose
  // input actually changed — rather than re-resolving every project whenever
  // any single project's branch settles (the old N² cascade).
  const resolvedInputKeyByProjectId = React.useRef<Map<string, string>>(new Map());

  // TTL cache: when a project's `gitRepoStatus` refreshes (it can fire on
  // every background poll even if the branch is unchanged), skip the
  // `getRootBranch` re-resolution if we resolved the same input within
  // the TTL window. 5 minutes matches the polling interval that typically
  // drives these refreshes, so we always serve cached results on
  // background updates and only re-resolve on cold start or actual
  // branch changes (those still invalidate via the input-key check).
  const rootBranchCacheRef = React.useRef<Map<string, { branch: string; at: number }>>(new Map());

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Debounce so the initial burst of per-project `ensureStatus` updates
    // settles into a single resolution pass instead of one pass per project.
    const timer = setTimeout(() => {
      const run = async () => {
        const validIds = new Set(normalizedProjects.map((project) => project.id));
        // Drop bookkeeping for projects that are no longer present.
        for (const id of resolvedInputKeyByProjectId.current.keys()) {
          if (!validIds.has(id)) {
            resolvedInputKeyByProjectId.current.delete(id);
            rootBranchCacheRef.current.delete(id);
          }
        }

        const now = Date.now();
        const pending = normalizedProjects.filter((project) => {
          const status = gitRepoStatus.get(project.normalizedPath);
          if (status?.isGitRepo === false) {
            resolvedInputKeyByProjectId.current.delete(project.id);
            rootBranchCacheRef.current.delete(project.id);
            return false;
          }
          if (status?.isGitRepo !== true || status.branch === null) {
            return false;
          }
          const currentBranch = status.branch.trim();
          const currentInputKey = `${project.normalizedPath}\0${currentBranch}`;
          const lastInputKey = resolvedInputKeyByProjectId.current.get(project.id);
          if (lastInputKey === currentInputKey) {
            // We've already resolved this exact (path, branch) pair.
            // The TTL cache is just an extra protection for the case
            // where the input key was reset by a transient blip —
            // keep the existing map entry fresh so future re-renders
            // hit the cache instead of refetching.
            const cached = rootBranchCacheRef.current.get(project.id);
            if (cached) cached.at = now;
            return false;
          }
          // Same input? Serve from TTL cache if it's still warm.
          if (lastInputKey !== undefined && now - (rootBranchCacheRef.current.get(project.id)?.at ?? 0) < ROOT_BRANCH_TTL_MS) {
            return false;
          }
          return true;
        });

        if (pending.length === 0) {
          return;
        }

        const resolved: Array<{ id: string; inputKey: string; branch: string }> = [];
        normalizedProjects.forEach((project) => {
          const inputBranch = gitRepoStatus.get(project.normalizedPath)?.branch?.trim() ?? '';
          const inputKey = `${project.normalizedPath}\0${inputBranch}`;
          if (inputBranch) {
            resolved.push({ id: project.id, inputKey, branch: inputBranch });
          }
        });

        if (cancelled || resolved.length === 0) {
          return;
        }

        const nowAfter = Date.now();
        setProjectRootBranches((prev) => {
          const next = new Map(prev);
          resolved.forEach(({ id, branch }) => {
            if (branch) {
              next.set(id, branch);
            }
          });
          return next;
        });
        resolved.forEach(({ id, inputKey, branch }) => {
          resolvedInputKeyByProjectId.current.set(id, inputKey);
          if (branch) {
            rootBranchCacheRef.current.set(id, { branch, at: nowAfter });
          }
        });
      };
      void run();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, normalizedProjects, projectGitBranchesKey, gitRepoStatus, setProjectRootBranches]);
};
