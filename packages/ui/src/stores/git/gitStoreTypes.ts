import type {
  GitStatus,
  GitBranch,
  GitLogResponse,
  GitRemote,
} from '@/lib/api/types';

export const LOG_STALE_THRESHOLD = 10000;
export const REPO_CHECK_STALE_THRESHOLD = 60_000;
export const STATUS_STALE_THRESHOLD = 5_000;
export const BRANCHES_STALE_THRESHOLD = 30_000;
// Mount-time (revisit) freshness windows for GitView's ensureAll stale-while-
// revalidate. Longer than the background thresholds above so a quick
// Git -> Terminal -> Files -> Git round-trip serves cache with zero requests.
// Explicit refresh paths (manual refresh, requestGitRefresh hints,
// post-mutation refresh) bypass these windows by calling fetch* directly.
export const STATUS_MOUNT_STALE_THRESHOLD = 15_000;
export const LOG_MOUNT_STALE_THRESHOLD = 30_000;
export const BRANCHES_MOUNT_STALE_THRESHOLD = 60_000;
// Remote list / remote URL change almost never (only remote add/remove), so a
// long window is safe; remote-changing mutations must call invalidateRemotes.
export const REMOTES_STALE_THRESHOLD = 5 * 60_000;
// Ranged (branch-divider) and graph log queries derive from the same commit
// data as the main log, so they share the mount-time log freshness.
export const LOG_QUERY_STALE_THRESHOLD = 30_000;
export const LOG_QUERY_CACHE_MAX_ENTRIES = 10;
export const DIFF_PREFETCH_MAX_FILES = 25;
export const DIFF_PREFETCH_FOCUS_MAX_FILES = 40;
export const DIFF_PREFETCH_CONCURRENCY = 2;
export const DIFF_PREFETCH_TIMEOUT_MS = 15000;
export const DIFF_PREFETCH_LARGE_FILE_THRESHOLD = 500; // skip prefetch for files with >500 changed lines

// Diff cache limits to prevent memory bloat with many modified files
export const DIFF_CACHE_MAX_ENTRIES = 30;
export const DIFF_CACHE_MAX_TOTAL_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
export const DIFF_CACHE_MAX_GLOBAL_ENTRIES = 200;
export type GitStatusFetchMode = 'full' | 'light';

export interface DirectoryGitState {
  isGitRepo: boolean | null;
  status: GitStatus | null;
  branches: GitBranch | null;
  log: GitLogResponse | null;
  remotes: GitRemote[] | null;
  remoteUrl: string | null;
  lastRemotesFetch: number;
  isLoadingRemotes: boolean;
  /** Ranged/graph log queries keyed by JSON of {from,to,all,file,maxCount}. */
  logQueryCache: Map<string, { log: GitLogResponse; fetchedAt: number }>;
  diffCache: Map<
    string,
    { original: string; modified: string; fetchedAt: number; isBinary?: boolean }
  >;
  indexRevision: number;
  lastRepoCheckAt: number;
  lastStatusFetch: number;
  lastStatusChange: number;
  lastLogFetch: number;
  lastBranchesFetch: number;
  logMaxCount: number;
  isLoadingStatus: boolean;
  isLoadingLog: boolean;
  isLoadingBranches: boolean;
}

export interface GitLogQueryOptions {
  from?: string;
  to?: string;
  all?: boolean;
  file?: string;
  maxCount?: number;
}

export const buildLogQueryKey = (options: GitLogQueryOptions): string =>
  JSON.stringify({
    from: options.from ?? null,
    to: options.to ?? null,
    all: options.all ?? false,
    file: options.file ?? null,
    maxCount: options.maxCount ?? null,
  });

export interface GitStore {
  runtimeKey: string;
  directories: Map<string, DirectoryGitState>;

  activeDirectory: string | null;

  setActiveDirectory: (directory: string | null) => void;
  getDirectoryState: (directory: string) => DirectoryGitState | null;

  fetchStatus: (
    directory: string,
    git: GitAPI,
    options?: { silent?: boolean; mode?: 'light' }
  ) => Promise<boolean>;
  fetchBranches: (
    directory: string,
    git: GitAPI,
    options?: { silent?: boolean }
  ) => Promise<void>;
  fetchLog: (
    directory: string,
    git: GitAPI,
    maxCount?: number,
    options?: { silent?: boolean }
  ) => Promise<void>;
  fetchAll: (
    directory: string,
    git: GitAPI,
    options?: { force?: boolean; silentIfCached?: boolean }
  ) => Promise<void>;

  ensureStatus: (directory: string, git: GitAPI) => Promise<void>;
  ensureAll: (directory: string, git: GitAPI) => Promise<void>;
  fetchRemotes: (
    directory: string,
    git: GitAPI,
    options?: { silent?: boolean; force?: boolean }
  ) => Promise<void>;
  ensureRemotes: (directory: string, git: GitAPI) => Promise<void>;
  /** Mark the remotes entry stale so the next ensure refetches (keeps data visible). */
  invalidateRemotes: (directory: string) => void;
  /**
   * Ranged/graph log query with store cache + in-flight dedupe, keyed by
   * (directory, from/to/all/file/maxCount). Returns the cached entry when
   * fresh; pass { force: true } for explicit manual refresh.
   * Failure preserves the prior cached entry and resolves null when none exists.
   */
  fetchLogQuery: (
    directory: string,
    git: GitAPI,
    query: GitLogQueryOptions,
    options?: { force?: boolean }
  ) => Promise<GitLogResponse | null>;
  getCachedLogQuery: (directory: string, query: GitLogQueryOptions) => GitLogResponse | null;
  moveStatusPathsOptimistically: (
    directory: string,
    paths: string[],
    direction: 'stage' | 'unstage'
  ) => GitStatus | null;
  restoreStatus: (directory: string, status: GitStatus | null) => void;
  bumpIndexRevision: (directory: string) => void;

  getDiff: (
    directory: string,
    filePath: string
  ) => {
    original: string;
    modified: string;
    fetchedAt: number;
    isBinary?: boolean;
  } | null;
  setDiff: (
    directory: string,
    filePath: string,
    diff: { original: string; modified: string; isBinary?: boolean },
    expectedRuntimeKey?: string
  ) => void;
  clearDiffCache: (directory: string, filePaths?: string[]) => void;
  fetchAllDiffs: (directory: string, git: GitAPI) => Promise<void>;
  prefetchDiffs: (
    directory: string,
    git: GitAPI,
    filePaths: string[],
    options?: { maxFiles?: number }
  ) => Promise<void>;

  setLogMaxCount: (directory: string, maxCount: number) => void;

  refresh: (git: GitAPI, options?: { force?: boolean }) => Promise<void>;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
}

export interface GitAPI {
  checkIsGitRepository: (directory: string) => Promise<boolean>;
  getGitStatus: (
    directory: string,
    options?: { mode?: 'light' }
  ) => Promise<GitStatus>;
  getGitBranches: (directory: string) => Promise<GitBranch>;
  getGitLog: (
    directory: string,
    options?: {
      maxCount?: number;
      from?: string;
      to?: string;
      file?: string;
      all?: boolean;
    }
  ) => Promise<GitLogResponse>;
  getRemotes?: (directory: string) => Promise<GitRemote[]>;
  getRemoteUrl?: (directory: string, remote?: string) => Promise<string | null>;
  getGitFileDiff: (
    directory: string,
    options: { path: string }
  ) => Promise<GitFileDiffResponse>;
}

export type GitRequestToken = {
  runtimeKey: string;
  runtimeGeneration: number;
  channelKey: string;
  requestGeneration: number;
  statusMutationRevision?: number;
};

export const createEmptyDirectoryState = (): DirectoryGitState => ({
  isGitRepo: null,
  status: null,
  branches: null,
  log: null,
  remotes: null,
  remoteUrl: null,
  lastRemotesFetch: 0,
  isLoadingRemotes: false,
  logQueryCache: new Map(),
  diffCache: new Map(),
  indexRevision: 0,
  lastRepoCheckAt: 0,
  lastStatusFetch: 0,
  lastStatusChange: 0,
  lastLogFetch: 0,
  lastBranchesFetch: 0,
  logMaxCount: 25,
  isLoadingStatus: false,
  isLoadingLog: false,
  isLoadingBranches: false,
});
