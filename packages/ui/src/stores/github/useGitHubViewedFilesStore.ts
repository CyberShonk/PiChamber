import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';

/**
 * Viewed-files state for the PR "Code" tab, keyed `${repo}#${number}`.
 *
 * Each entry stores the viewed file paths together with the `headSha` they
 * were viewed at: when the PR head moves, the stored marks are stale, so
 * `syncHeadSha` clears them instead of showing reviews against the wrong
 * revision as done. Persisted to localStorage (viewed marks are durable
 * reading progress, unlike half-written review drafts which stay
 * in-memory in `useGitHubPendingReviewStore`).
 */

export const viewedFilesKey = (repo: string, number: number): string => `${repo}#${number}`;

/** Bound on persisted per-PR heads; least-recently-written heads evict first. */
export const MAX_VIEWED_FILE_HEADS = 50;

type ViewedFilesEntry = {
  viewed: string[];
  headSha: string | null;
};

// Stable fallback: selectors must return referentially stable values, never
// a fresh array per call.
const EMPTY_VIEWED: readonly string[] = Object.freeze([]);

type ViewedFilesStoreState = {
  entries: Record<string, ViewedFilesEntry>;
  setViewed: (repo: string, number: number, path: string, viewed: boolean) => void;
  /**
   * Record the current head SHA. When it differs from the stored one, the
   * viewed marks belong to an older revision and are cleared.
   */
  syncHeadSha: (repo: string, number: number, headSha: string | null) => void;
  resetForRuntimeSwitch: () => void;
};

const pruneHeads = (
  entries: Record<string, ViewedFilesEntry>,
  keepKey: string,
): Record<string, ViewedFilesEntry> => {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_VIEWED_FILE_HEADS) return entries;
  const next: Record<string, ViewedFilesEntry> = {};
  for (const key of keys.slice(keys.length - MAX_VIEWED_FILE_HEADS)) {
    next[key] = entries[key] as ViewedFilesEntry;
  }
  // The just-touched head is always retained even when it is the oldest.
  if (!(keepKey in next) && keepKey in entries) {
    const oldest = Object.keys(next)[0] as string;
    delete next[oldest];
    next[keepKey] = entries[keepKey] as ViewedFilesEntry;
  }
  return next;
};

export const useGitHubViewedFilesStore = create<ViewedFilesStoreState>()(
  persist(
    (set, get) => ({
      entries: {},

      setViewed: (repo, number, path, viewed) => {
        const key = viewedFilesKey(repo, number);
        const current = get().entries[key];
        const has = current?.viewed.includes(path) ?? false;
        if (has === viewed) return;
        set((state) => {
          const entry = state.entries[key] ?? { viewed: [], headSha: null };
          const next = viewed
            ? [...entry.viewed, path]
            : entry.viewed.filter((candidate) => candidate !== path);
          return { entries: pruneHeads({ ...state.entries, [key]: { ...entry, viewed: next } }, key) };
        });
      },

      syncHeadSha: (repo, number, headSha) => {
        const key = viewedFilesKey(repo, number);
        const current = get().entries[key];
        if (current && current.headSha === (headSha ?? null)) return;
        // Note: when there was no entry we still record the head SHA so the
        // first `setViewed` call stores marks against the right revision.
        set((state) => ({
          entries: pruneHeads(
            { ...state.entries, [key]: { viewed: [], headSha: headSha ?? null } },
            key,
          ),
        }));
      },

      resetForRuntimeSwitch: () => set({ entries: {} }),
    }),
    {
      name: 'pichamber:github-viewed-files',
      version: 1,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ entries: state.entries }) as ViewedFilesStoreState,
    },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(() => {
    useGitHubViewedFilesStore.getState().resetForRuntimeSwitch();
  });
}

/** Viewed paths for a PR; stable empty array when there are none. */
export const useViewedFilePaths = (repo: string, number: number): readonly string[] =>
  useGitHubViewedFilesStore((state) => state.entries[viewedFilesKey(repo, number)]?.viewed ?? EMPTY_VIEWED);

/** Count of viewed files; 0 when there are none. */
export const useViewedFileCount = (repo: string, number: number): number =>
  useGitHubViewedFilesStore((state) => state.entries[viewedFilesKey(repo, number)]?.viewed.length ?? 0);
