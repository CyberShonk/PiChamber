// PR collection contracts: wide pages, failure-is-not-empty, paging, remote isolation.
// Failures keep last-known items and cursors; remote errors stay inline.
import { beforeEach, describe, expect, test } from 'bun:test';
import { GitHubAPIError } from '@/lib/api/types';
import type { GitHubAPI, GitHubPullsQuery } from '@/lib/api/types';
import {
  getPullCommentsEntry,
  getPullsCollectionEntry,
  getPullsRemoteEntry,
  useGitHubPullRequestsStore,
} from '@/stores/useGitHubPullRequestsStore';

const repo = 'github.com/octocat/hello-world';
const directory = '/repo';

const prSummary = (number: number) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/octocat/hello-world/pull/${number}`,
  state: 'open' as const,
  draft: false,
  base: 'main',
  head: `feature-${number}`,
  author: { login: 'octocat' },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-02-01T00:00:00Z',
});

type PullsListCall = { state?: string; cursor?: string | null; perPage?: number; q?: string };

/** Full fake GitHubAPI: no partial mocks of shared modules. */
const fakeGithub = (overrides: Partial<Record<string, (...args: never[]) => Promise<never>>> = {}): { api: GitHubAPI; listCalls: PullsListCall[] } => {
  const listCalls: PullsListCall[] = [];
  const api = {
    pullsList: async (_dir: string, _repo: string, query?: GitHubPullsQuery) => {
      listCalls.push({ state: query?.state, cursor: query?.cursor, perPage: query?.perPage, q: query?.q });
      if (query?.q) {
        return { repo: {}, items: [prSummary(99)], nextCursor: null, fetchedAt: Date.now() };
      }
      if (query?.state === 'closed') {
        return { repo: {}, items: [prSummary(3)], nextCursor: null, fetchedAt: Date.now() };
      }
      if (query?.cursor === 'page-2') {
        return { repo: {}, items: [prSummary(2)], nextCursor: null, fetchedAt: Date.now() };
      }
      return { repo: {}, items: [prSummary(1)], nextCursor: 'page-2', fetchedAt: Date.now() };
    },
    pullComments: async (_dir: string, _repo: string, _number: number, cursor?: string | null) => {
      if (cursor === 'page-2') {
        return { repo: {}, number: 1, comments: [{ id: 2, body: 'second' }], nextCursor: null, fetchedAt: Date.now() };
      }
      return { repo: {}, number: 1, comments: [{ id: 1, body: 'first' }], nextCursor: 'page-2', fetchedAt: Date.now() };
    },
    invalidate: async () => ({ ok: true, fetchedAt: Date.now() }),
    ...overrides,
  };
  return { api: api as unknown as GitHubAPI, listCalls };
};

const waitFor = async (condition: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('useGitHubPullRequestsStore collections', () => {
  beforeEach(() => {
    useGitHubPullRequestsStore.getState().resetForRuntimeSwitch();
  });

  test('collections fetch wide pages and prefetch closed in the background', async () => {
    const { api, listCalls } = fakeGithub();
    const store = useGitHubPullRequestsStore.getState();
    await store.ensureCollectionsFresh(directory, repo, 'open', api);
    // Wide local pages; search/sort/involvement stay local views and never hit the network.
    expect(listCalls[0]).toMatchObject({ state: 'open', perPage: 100 });
    for (const call of listCalls) expect(call.q).toBe(undefined);
    expect(getPullsCollectionEntry(repo, 'open')?.data?.items.map((item) => item.number)).toEqual([1]);
    // Closed prefetches behind open so state-tab switches land instantly.
    await waitFor(() => getPullsCollectionEntry(repo, 'closed')?.data != null);
    expect(getPullsCollectionEntry(repo, 'closed')?.data?.items.map((item) => item.number)).toEqual([3]);
  });

  test('load-more failure keeps loaded pages with the cursor intact', async () => {
    let shouldFail = false;
    const { api } = fakeGithub({
      pullsList: (async (_d: string, _r: string, query?: GitHubPullsQuery) => {
        if (shouldFail && query?.cursor) throw new GitHubAPIError({ kind: 'failed', message: 'boom' }, 502);
        if (query?.cursor === 'page-2') {
          return { repo: {}, items: [prSummary(2)], nextCursor: null, fetchedAt: Date.now() };
        }
        return { repo: {}, items: [prSummary(1)], nextCursor: 'page-2', fetchedAt: Date.now() };
      }) as never,
    });
    const store = useGitHubPullRequestsStore.getState();
    await store.ensureCollection(directory, repo, 'open', api);
    await store.loadMoreCollection(directory, repo, 'open', api);
    expect(getPullsCollectionEntry(repo, 'open')?.data?.items.map((item) => item.number)).toEqual([1, 2]);

    // A failing next page must not drop the loaded first page or the cursor.
    useGitHubPullRequestsStore.getState().resetForRuntimeSwitch();
    await useGitHubPullRequestsStore.getState().ensureCollection(directory, repo, 'open', api);
    shouldFail = true;
    await useGitHubPullRequestsStore.getState().loadMoreCollection(directory, repo, 'open', api);
    const entry = getPullsCollectionEntry(repo, 'open');
    expect(entry?.data?.items.map((item) => item.number)).toEqual([1]);
    expect(entry?.data?.nextCursor).toBe('page-2');
    expect(entry?.error?.kind).toBe('failed');
  });

  test('failed refresh keeps previous data marked stale, never empty', async () => {
    let shouldFail = false;
    const { api } = fakeGithub({
      pullsList: (async () => {
        if (shouldFail) throw new GitHubAPIError({ kind: 'failed', message: 'boom' }, 502);
        return { repo: {}, items: [prSummary(1)], nextCursor: null, fetchedAt: Date.now() };
      }) as never,
    });
    const store = useGitHubPullRequestsStore.getState();
    await store.refreshCollections(directory, repo, 'open', api);
    shouldFail = true;
    await store.refreshCollections(directory, repo, 'open', api);
    const entry = getPullsCollectionEntry(repo, 'open');
    expect(entry?.data?.items).toHaveLength(1);
    expect(entry?.stale).toBe(true);
    expect(entry?.data?.nextCursor).toBe(null);
    expect(entry?.error?.kind).toBe('failed');
  });

  test('comment pages append without duplicating ids', async () => {
    const { api } = fakeGithub();
    const store = useGitHubPullRequestsStore.getState();
    await store.ensureComments(directory, repo, 1, api);
    expect(getPullCommentsEntry(repo, 1)?.data?.comments.map((comment) => comment.id)).toEqual([1]);
    await store.loadMoreComments(directory, repo, 1, api);
    expect(getPullCommentsEntry(repo, 1)?.data?.comments.map((comment) => comment.id)).toEqual([1, 2]);
  });

  test('remote search failure stays inline and keeps local rows', async () => {
    const { api } = fakeGithub({
      pullsList: (async (_d: string, _r: string, query?: GitHubPullsQuery) => {
        if (query?.q) throw new GitHubAPIError({ kind: 'rate-limited', retryAt: 123 }, 403);
        return { repo: {}, items: [prSummary(1)], nextCursor: null, fetchedAt: Date.now() };
      }) as never,
    });
    const store = useGitHubPullRequestsStore.getState();
    await store.ensureCollection(directory, repo, 'open', api);
    const query = { state: 'open' as const, involvement: 'all' as const, q: 'boom' };
    await store.searchRemote(directory, repo, query, api);
    const remote = getPullsRemoteEntry(repo, query);
    expect(remote?.data).toBe(null);
    expect(remote?.error?.kind).toBe('rate-limited');
    // Local collection rows are untouched by the remote failure.
    expect(getPullsCollectionEntry(repo, 'open')?.data?.items).toHaveLength(1);
  });
});
