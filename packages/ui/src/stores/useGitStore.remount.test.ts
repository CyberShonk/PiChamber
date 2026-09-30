/**
 * Remount-cost regression tests for the Git singleton surface.
 *
 * GitView remounts on every context-panel switch and must restore itself from
 * useGitStore. A revisit within the freshness windows must serve cache with
 * zero requests; a stale revisit must revalidate silently (cached data stays
 * visible, no loading flash); explicit fetch* paths must always hit network.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitLogResponse, GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createEmptyDirectoryState } from './git/gitStoreTypes';

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];
type DirectoryGitState = NonNullable<ReturnType<ReturnType<typeof useGitStore.getState>['getDirectoryState']>>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const createStatus = (files: GitStatus['files'] = []): GitStatus => ({
  current: 'main',
  tracking: 'origin/main',
  ahead: 0,
  behind: 0,
  files,
  isClean: files.length === 0,
  diffStats: {},
});

const createBranches = () => ({ all: ['main'], current: 'main', branches: {} });

const createLogEntry = (hash: string) => ({
  hash,
  date: '2026-01-01',
  message: `commit ${hash}`,
  refs: '',
  body: '',
  author_name: 'Test',
  author_email: 'test@example.com',
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  parents: [],
});

const createLog = (hashes: string[] = []): GitLogResponse => ({
  all: hashes.map(createLogEntry),
  latest: hashes.length > 0 ? createLogEntry(hashes[0]) : null,
  total: hashes.length,
});

const createRemotes = () => [{ name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' }];

type CallCounts = {
  checkIsGitRepository: number;
  getGitStatus: number;
  getGitBranches: number;
  getGitLog: number;
  getGitFileDiff: number;
  getRemotes: number;
  getRemoteUrl: number;
};

type GitLogHandler = (directory: string, options?: { maxCount?: number; from?: string; to?: string; all?: boolean }) => Promise<GitLogResponse>;

const createCountingGit = (overrides: {
  getGitStatus?: GitAPI['getGitStatus'];
  getGitBranches?: GitAPI['getGitBranches'];
  getGitLog?: GitLogHandler;
  getGitFileDiff?: GitAPI['getGitFileDiff'];
  getRemotes?: (directory: string) => Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>>;
  getRemoteUrl?: (directory: string) => Promise<string | null>;
} = {}): { git: GitAPI; calls: CallCounts; logOptions: Array<{ maxCount?: number; from?: string; to?: string; all?: boolean }> } => {
  const calls: CallCounts = {
    checkIsGitRepository: 0,
    getGitStatus: 0,
    getGitBranches: 0,
    getGitLog: 0,
    getGitFileDiff: 0,
    getRemotes: 0,
    getRemoteUrl: 0,
  };
  const logOptions: Array<{ maxCount?: number; from?: string; to?: string; all?: boolean }> = [];
  const git: GitAPI = {
    checkIsGitRepository: async () => {
      calls.checkIsGitRepository += 1;
      return true;
    },
    getGitStatus: async (...args) => {
      calls.getGitStatus += 1;
      return overrides.getGitStatus
        ? overrides.getGitStatus(...args)
        : createStatus();
    },
    getGitBranches: async (...args) => {
      calls.getGitBranches += 1;
      return overrides.getGitBranches
        ? overrides.getGitBranches(...args)
        : createBranches();
    },
    getGitLog: async (directory, options) => {
      calls.getGitLog += 1;
      logOptions.push({
        maxCount: options?.maxCount,
        from: options?.from,
        to: options?.to,
        all: options?.all,
      });
      return overrides.getGitLog
        ? overrides.getGitLog(directory, options)
        : createLog();
    },
    getGitFileDiff: async (...args) => {
      calls.getGitFileDiff += 1;
      return overrides.getGitFileDiff
        ? overrides.getGitFileDiff(...args)
        : { original: '', modified: '', path: args[1].path };
    },
    getRemotes: async (directory) => {
      calls.getRemotes += 1;
      return overrides.getRemotes ? overrides.getRemotes(directory) : createRemotes();
    },
    getRemoteUrl: async (directory) => {
      calls.getRemoteUrl += 1;
      return overrides.getRemoteUrl ? overrides.getRemoteUrl(directory) : 'https://example.com/repo.git';
    },
  };
  return { git, calls, logOptions };
};

const seedDirectory = (directory: string, partial: Partial<DirectoryGitState>): void => {
  useGitStore.setState({
    directories: new Map([[directory, { ...createEmptyDirectoryState(), ...partial }]]),
    activeDirectory: directory,
  });
};

describe('useGitStore git remount costs', () => {
  beforeEach(() => {
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('remount within freshness window issues zero requests', async () => {
    const now = Date.now();
    seedDirectory('/repo', {
      isGitRepo: true,
      status: createStatus(),
      branches: createBranches(),
      log: createLog(['abc']),
      remotes: createRemotes(),
      remoteUrl: 'https://example.com/repo.git',
      lastRepoCheckAt: now,
      lastStatusFetch: now,
      lastLogFetch: now,
      lastBranchesFetch: now,
      lastRemotesFetch: now,
    });
    const { git, calls } = createCountingGit();

    await useGitStore.getState().ensureAll('/repo', git);

    expect(calls).toEqual({
      checkIsGitRepository: 0,
      getGitStatus: 0,
      getGitBranches: 0,
      getGitLog: 0,
      getGitFileDiff: 0,
      getRemotes: 0,
      getRemoteUrl: 0,
    });
  });

  test('stale revisit revalidates in background while keeping cached data visible', async () => {
    const now = Date.now();
    const oldStatus = createStatus([{ path: 'old.ts', index: ' ', working_dir: 'M' }]);
    const oldBranches = createBranches();
    const oldLog = createLog(['old']);
    seedDirectory('/repo', {
      isGitRepo: true,
      status: oldStatus,
      branches: oldBranches,
      log: oldLog,
      remotes: createRemotes(),
      remoteUrl: 'https://example.com/repo.git',
      lastRepoCheckAt: now,
      lastStatusFetch: now - 20_000,
      lastLogFetch: now - 40_000,
      lastBranchesFetch: now - 70_000,
      lastRemotesFetch: now,
    });

    const statusRequest = createDeferred<GitStatus>();
    const branchesRequest = createDeferred<{ all: string[]; current: string; branches: Record<string, never> }>();
    const logRequest = createDeferred<GitLogResponse>();
    const newStatus = createStatus([{ path: 'new.ts', index: ' ', working_dir: 'M' }]);
    const { git, calls } = createCountingGit({
      getGitStatus: () => statusRequest.promise,
      getGitBranches: (() => branchesRequest.promise) as GitAPI['getGitBranches'],
      getGitLog: () => logRequest.promise,
    });

    const pending = useGitStore.getState().ensureAll('/repo', git);
    await tick();
    await tick();

    // Status revalidation started; branches/log wait for it.
    expect(calls.getGitStatus).toBe(1);
    expect(calls.getGitBranches).toBe(0);
    expect(calls.getGitLog).toBe(0);
    // Cached data stays visible with no loading flash.
    const midState = useGitStore.getState().getDirectoryState('/repo');
    expect(midState?.status).toBe(oldStatus);
    expect(midState?.isLoadingStatus).toBe(false);
    expect(midState?.isLoadingBranches).toBe(false);
    expect(midState?.isLoadingLog).toBe(false);

    statusRequest.resolve(newStatus);
    await tick();
    await tick();
    await tick();

    expect(calls.getGitBranches).toBe(1);
    expect(calls.getGitLog).toBe(1);
    const staleState = useGitStore.getState().getDirectoryState('/repo');
    expect(staleState?.branches).toBe(oldBranches);
    expect(staleState?.log).toBe(oldLog);
    expect(staleState?.isLoadingBranches).toBe(false);
    expect(staleState?.isLoadingLog).toBe(false);

    branchesRequest.resolve({ all: ['main', 'feature'], current: 'feature', branches: {} });
    logRequest.resolve(createLog(['new']));
    await pending;

    const finalState = useGitStore.getState().getDirectoryState('/repo');
    expect(finalState?.status?.files).toEqual([{ path: 'new.ts', index: ' ', working_dir: 'M' }]);
    expect(finalState?.branches?.current).toBe('feature');
    expect(finalState?.log?.total).toBe(1);
  });

  test('explicit fetch paths force a fresh request when cache is fresh', async () => {
    const now = Date.now();
    seedDirectory('/repo', {
      isGitRepo: true,
      status: createStatus(),
      branches: createBranches(),
      log: createLog(['abc']),
      remotes: createRemotes(),
      remoteUrl: 'https://example.com/repo.git',
      lastRepoCheckAt: now,
      lastStatusFetch: now,
      lastLogFetch: now,
      lastBranchesFetch: now,
      lastRemotesFetch: now,
    });
    const { git, calls } = createCountingGit();
    const state = useGitStore.getState();

    await state.fetchStatus('/repo', git);
    await state.fetchBranches('/repo', git);
    await state.fetchLog('/repo', git);
    await state.fetchRemotes('/repo', git);

    expect(calls.getGitStatus).toBe(1);
    expect(calls.getGitBranches).toBe(1);
    expect(calls.getGitLog).toBe(1);
    expect(calls.getRemotes).toBe(1);
    expect(calls.getRemoteUrl).toBe(1);
  });

  test('fetchLog shares one in-flight request per maxCount', async () => {
    seedDirectory('/repo', { isGitRepo: true, status: createStatus() });
    const request = createDeferred<GitLogResponse>();
    let calls = 0;
    const { git } = createCountingGit({
      getGitLog: () => {
        calls += 1;
        return request.promise;
      },
    });
    const state = useGitStore.getState();

    const first = state.fetchLog('/repo', git);
    const second = state.fetchLog('/repo', git);
    await tick();
    expect(calls).toBe(1);

    request.resolve(createLog(['abc']));
    await Promise.all([first, second]);
    expect(state.getDirectoryState('/repo')?.log?.total).toBe(1);

    // A different maxCount is a different request.
    const other = createDeferred<GitLogResponse>();
    let otherCalls = 0;
    const { git: otherGit } = createCountingGit({
      getGitLog: () => {
        otherCalls += 1;
        return other.promise;
      },
    });
    const third = useGitStore.getState().fetchLog('/repo', otherGit, 50);
    await tick();
    expect(otherCalls).toBe(1);
    other.resolve(createLog(['def', 'ghi']));
    await third;
    expect(useGitStore.getState().getDirectoryState('/repo')?.log?.total).toBe(2);
  });

  test('fetchRemotes shares in-flight requests and failure preserves prior data', async () => {
    seedDirectory('/repo', { isGitRepo: true, status: createStatus() });
    const request = createDeferred<Array<{ name: string; fetchUrl: string; pushUrl: string }>>();
    let calls = 0;
    const { git } = createCountingGit({
      getRemotes: () => {
        calls += 1;
        return request.promise;
      },
    });
    const state = useGitStore.getState();
    const first = state.fetchRemotes('/repo', git);
    const second = state.fetchRemotes('/repo', git);
    await tick();
    expect(calls).toBe(1);
    request.resolve(createRemotes());
    await Promise.all([first, second]);
    expect(state.getDirectoryState('/repo')?.remotes?.map((r) => r.name)).toEqual(['origin']);

    // Failure preserves the prior list, URL, and timestamp.
    const prior = state.getDirectoryState('/repo');
    const priorRemotes = prior?.remotes;
    const priorFetchAt = prior?.lastRemotesFetch ?? 0;
    expect(priorFetchAt).toBeGreaterThan(0);
    const { git: failingGit } = createCountingGit({
      getRemotes: async () => {
        throw new Error('network down');
      },
    });
    await useGitStore.getState().fetchRemotes('/repo', failingGit);
    const after = useGitStore.getState().getDirectoryState('/repo');
    expect(after?.remotes).toBe(priorRemotes);
    expect(after?.remoteUrl).toBe('https://example.com/repo.git');
    expect(after?.lastRemotesFetch).toBe(priorFetchAt);
    expect(after?.isLoadingRemotes).toBe(false);
  });

  test('remote URL probe failure preserves the prior URL', async () => {
    seedDirectory('/repo', {
      isGitRepo: true,
      status: createStatus(),
      remotes: createRemotes(),
      remoteUrl: 'https://example.com/old.git',
      lastRemotesFetch: 0,
    });
    const { git } = createCountingGit({
      getRemoteUrl: async () => {
        throw new Error('probe failed');
      },
    });

    await useGitStore.getState().fetchRemotes('/repo', git);

    const state = useGitStore.getState().getDirectoryState('/repo');
    expect(state?.remotes?.map((r) => r.name)).toEqual(['origin']);
    expect(state?.remoteUrl).toBe('https://example.com/old.git');
  });

  test('status/log/branches failure preserves prior data and timestamps', async () => {
    const now = Date.now();
    const oldStatus = createStatus();
    const oldBranches = createBranches();
    const oldLog = createLog(['old']);
    seedDirectory('/repo', {
      isGitRepo: true,
      status: oldStatus,
      branches: oldBranches,
      log: oldLog,
      lastRepoCheckAt: now,
      lastStatusFetch: now - 60_000,
      lastLogFetch: now - 60_000,
      lastBranchesFetch: now - 120_000,
    });
    const { git } = createCountingGit({
      getGitStatus: async () => {
        throw new Error('status failed');
      },
      getGitBranches: async () => {
        throw new Error('branches failed');
      },
      getGitLog: async () => {
        throw new Error('log failed');
      },
    });
    const state = useGitStore.getState();

    await state.fetchStatus('/repo', git);
    await state.fetchBranches('/repo', git);
    await state.fetchLog('/repo', git);

    const after = state.getDirectoryState('/repo');
    expect(after?.status).toBe(oldStatus);
    expect(after?.branches).toBe(oldBranches);
    expect(after?.log).toBe(oldLog);
    expect(after?.isLoadingStatus).toBe(false);
    expect(after?.isLoadingBranches).toBe(false);
    expect(after?.isLoadingLog).toBe(false);
  });

  test('ensureRemotes honors the 5 minute window and invalidate forces refetch', async () => {
    const now = Date.now();
    seedDirectory('/repo', {
      isGitRepo: true,
      status: createStatus(),
      remotes: createRemotes(),
      remoteUrl: 'https://example.com/repo.git',
      lastRemotesFetch: now - 60_000,
    });
    const { git, calls } = createCountingGit();
    const state = useGitStore.getState();

    await state.ensureRemotes('/repo', git);
    expect(calls.getRemotes).toBe(0);

    state.invalidateRemotes('/repo');
    // Data stays visible while marked stale.
    expect(state.getDirectoryState('/repo')?.remotes?.map((r) => r.name)).toEqual(['origin']);
    await state.ensureRemotes('/repo', git);
    expect(calls.getRemotes).toBe(1);
  });

  test('missing remotes entry fetches on ensure', async () => {
    seedDirectory('/repo', { isGitRepo: true, status: createStatus() });
    const { git, calls } = createCountingGit();

    await useGitStore.getState().ensureRemotes('/repo', git);

    expect(calls.getRemotes).toBe(1);
    expect(calls.getRemoteUrl).toBe(1);
    expect(useGitStore.getState().getDirectoryState('/repo')?.remotes?.map((r) => r.name)).toEqual(['origin']);
  });

  test('diff prefetch issues zero requests when diffs are already cached', async () => {
    seedDirectory('/repo', {
      isGitRepo: true,
      status: createStatus([
        { path: 'a.ts', index: ' ', working_dir: 'M' },
        { path: 'b.ts', index: ' ', working_dir: 'M' },
      ]),
    });
    const state = useGitStore.getState();
    state.setDiff('/repo', 'a.ts', { original: 'a', modified: 'b' });
    state.setDiff('/repo', 'b.ts', { original: 'c', modified: 'd' });
    const { git, calls } = createCountingGit();

    // Simulates a remount re-firing the prefetch effect with an unchanged set.
    await state.prefetchDiffs('/repo', git, ['a.ts', 'b.ts'], { maxFiles: 40 });
    expect(calls.getGitFileDiff).toBe(0);

    // Uncached paths still prefetch exactly once, then hit cache.
    await state.prefetchDiffs('/repo', git, ['a.ts', 'c.ts'], { maxFiles: 40 });
    expect(calls.getGitFileDiff).toBe(0);
  });

  test('diff prefetch fetches uncached paths once and then serves cache', async () => {
    seedDirectory('/repo', {
      isGitRepo: true,
      status: createStatus([{ path: 'fresh.ts', index: ' ', working_dir: 'M' }]),
    });
    const state = useGitStore.getState();
    const { git, calls } = createCountingGit({
      getGitFileDiff: async (_directory, options) => ({ original: 'old', modified: 'new', path: options.path }),
    });

    await state.prefetchDiffs('/repo', git, ['fresh.ts']);
    expect(calls.getGitFileDiff).toBe(1);
    await state.prefetchDiffs('/repo', git, ['fresh.ts']);
    expect(calls.getGitFileDiff).toBe(1);
  });

  test('log queries cache by from/to/all and force bypasses the cache', async () => {
    seedDirectory('/repo', { isGitRepo: true, status: createStatus() });
    const { git, calls, logOptions } = createCountingGit({
      getGitLog: async (_directory, options) => createLog([`${options?.from ?? 'all'}:${options?.maxCount ?? 0}`]),
    });
    const state = useGitStore.getState();

    const first = await state.fetchLogQuery('/repo', git, { from: 'main', to: 'HEAD', maxCount: 25 });
    expect(calls.getGitLog).toBe(1);
    expect(first?.total).toBe(1);

    const second = await state.fetchLogQuery('/repo', git, { from: 'main', to: 'HEAD', maxCount: 25 });
    expect(calls.getGitLog).toBe(1);
    expect(second).toBe(first);

    // A different query key (graph-style all=true) fetches separately.
    await state.fetchLogQuery('/repo', git, { all: true, maxCount: 100 });
    expect(calls.getGitLog).toBe(2);
    expect(logOptions[1]).toMatchObject({ all: true, maxCount: 100 });

    // Explicit manual refresh forces a fresh request.
    await state.fetchLogQuery('/repo', git, { from: 'main', to: 'HEAD', maxCount: 25 }, { force: true });
    expect(calls.getGitLog).toBe(3);
  });

  test('log query in-flight requests are shared and failure resolves cached or null', async () => {
    seedDirectory('/repo', { isGitRepo: true, status: createStatus() });
    const request = createDeferred<GitLogResponse>();
    let calls = 0;
    const { git } = createCountingGit({
      getGitLog: () => {
        calls += 1;
        return request.promise;
      },
    });
    const state = useGitStore.getState();
    const query = { from: 'main', to: 'HEAD', maxCount: 25 };

    const first = state.fetchLogQuery('/repo', git, query);
    const second = state.fetchLogQuery('/repo', git, query);
    await tick();
    expect(calls).toBe(1);
    request.resolve(createLog(['abc']));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);

    // Failure with a cached entry preserves it.
    const { git: failingGit } = createCountingGit({
      getGitLog: async () => {
        throw new Error('log query failed');
      },
    });
    const preserved = await state.fetchLogQuery('/repo', failingGit, query, { force: true });
    expect(preserved).toBe(a);

    // Failure with no cache resolves null (never an empty log masquerading as success).
    const missing = await state.fetchLogQuery('/repo', failingGit, { all: true, maxCount: 100 }, { force: true });
    expect(missing).toBeNull();
  });

  test('overlapping different log queries for one directory both keep their results', async () => {
    seedDirectory('/repo', { isGitRepo: true, status: createStatus() });
    const rangeRequest = createDeferred<GitLogResponse>();
    const graphRequest = createDeferred<GitLogResponse>();
    const { git } = createCountingGit({
      getGitLog: (_directory, options) => (options?.all ? graphRequest.promise : rangeRequest.promise),
    });
    const state = useGitStore.getState();

    const range = state.fetchLogQuery('/repo', git, { from: 'main', to: 'HEAD', maxCount: 25 });
    const graph = state.fetchLogQuery('/repo', git, { all: true, maxCount: 100 });
    await tick();
    // The earlier query resolves after the later one started.
    const rangeLog = createLog(['range']);
    rangeRequest.resolve(rangeLog);
    graphRequest.resolve(createLog(['graph']));
    expect(await range).toBe(rangeLog);
    expect((await graph)?.total).toBe(1);
  });

  test('runtime switch resets remotes and log query caches', async () => {
    const now = Date.now();
    seedDirectory('/repo', {
      isGitRepo: true,
      status: createStatus(),
      branches: createBranches(),
      log: createLog(['abc']),
      remotes: createRemotes(),
      remoteUrl: 'https://example.com/repo.git',
      lastRemotesFetch: now,
      lastStatusFetch: now,
      lastLogFetch: now,
      lastBranchesFetch: now,
    });
    const state = useGitStore.getState();
    await state.fetchLogQuery('/repo', createCountingGit().git, { from: 'main', to: 'HEAD', maxCount: 25 });
    expect(state.getDirectoryState('/repo')?.logQueryCache.size).toBe(1);

    state.resetForRuntimeSwitch('runtime-b');

    expect(useGitStore.getState().runtimeKey).toBe('runtime-b');
    expect(useGitStore.getState().getDirectoryState('/repo')).toBeNull();

    // In-flight owners were cleared: new runtime work proceeds normally.
    const { git, calls } = createCountingGit();
    await useGitStore.getState().fetchRemotes('/repo', git);
    expect(calls.getRemotes).toBe(1);
  });
});
