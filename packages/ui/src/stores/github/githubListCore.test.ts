// Core GitHub list invariants: per-key isolation, bounded LRU, load-more failures, agent-turn staleness.
// Settling one key never notifies another; eviction never drops in-flight or subscribed entries.
import { beforeEach, describe, expect, test } from 'bun:test';
import { GitHubAPIError } from '@/lib/api/types';
import type { GitHubAPI, GitHubPullsQuery } from '@/lib/api/types';
import { createKeyedAsyncResource } from './githubAsyncResource';
import {
  findPullSeed,
  getPullDetailEntry,
  getPullsCollectionEntry,
  getPullsRemoteEntry,
  pullsCollectionKeyFor,
  pullDetailKeyFor,
  useGitHubPullRequestsStore,
} from '@/stores/useGitHubPullRequestsStore';

const repoA = 'github.com/octocat/repo-a';
const repoB = 'github.com/octocat/repo-b';
const directory = '/repo';

const prSummary = (number: number) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/octocat/x/pull/${number}`,
  state: 'open' as const,
  draft: false,
  base: 'main',
  head: `feature-${number}`,
  author: { login: 'octocat' },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-02-01T00:00:00Z',
});

/** Full fake GitHubAPI: no partial mocks of shared modules. */
const fakeGithub = (overrides: Record<string, (...args: never[]) => Promise<never>> = {}): { api: GitHubAPI; calls: { pulls: number } } => {
  const calls = { pulls: 0 };
  const base: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    pullsList: async (_d: unknown, _r: unknown, query: unknown) => {
      calls.pulls += 1;
      const q = query as GitHubPullsQuery | undefined;
      if (q?.q) {
        return { repo: {}, items: [prSummary(99)], nextCursor: null, fetchedAt: Date.now() };
      }
      if (q?.cursor) {
        return { repo: {}, items: [prSummary(2)], nextCursor: null, fetchedAt: Date.now() };
      }
      return { repo: {}, items: [prSummary(1)], nextCursor: 'page-2', fetchedAt: Date.now() };
    },
    pullGet: async (_d: unknown, _r: unknown, n: unknown) => ({
      repo: {}, pr: { ...prSummary(n as number) }, reviews: [], threads: [], fetchedAt: Date.now(),
    }),
    invalidate: async () => ({ ok: true, fetchedAt: Date.now() }),
  };
  return { api: { ...base, ...overrides } as unknown as GitHubAPI, calls };
};

describe('per-key change signals', () => {
  beforeEach(() => {
    useGitHubPullRequestsStore.getState().resetForRuntimeSwitch();
  });

  test('a settling load notifies only its own key subscribers', async () => {
    const { api } = fakeGithub();
    const store = useGitHubPullRequestsStore.getState();
    await store.ensureCollection(directory, repoA, 'open', api);

    // Resource level: settling key A never notifies key B subscribers.
    const { createKeyedAsyncResource: create } = await import('./githubAsyncResource');
    const resource = create<string>();
    let notifiedB = 0;
    let notifiedA = 0;
    resource.subscribe('b', () => { notifiedB += 1; });
    resource.subscribe('a', () => { notifiedA += 1; });
    await resource.refresh('a', async () => 'v1');
    expect(notifiedA).toBeGreaterThan(0);
    expect(notifiedB).toBe(0);

    // Store level: settling repo B's collection leaves repo A's entry alone.
    const beforeA = getPullsCollectionEntry(repoA, 'open');
    await store.ensureCollectionsFresh(directory, repoB, 'open', api);
    expect(getPullsCollectionEntry(repoA, 'open')).toBe(beforeA);
    expect(getPullsCollectionEntry(repoB, 'open')?.data?.items).toHaveLength(1);
  });

  test('detail loads for one PR do not touch another PR entry', async () => {
    const { api } = fakeGithub();
    const store = useGitHubPullRequestsStore.getState();
    await store.ensureDetail(directory, repoA, 1, api);
    const before = getPullDetailEntry(repoA, 1);
    await store.ensureDetail(directory, repoA, 2, api);
    expect(getPullDetailEntry(repoA, 1)).toBe(before);
    expect(getPullDetailEntry(repoA, 2)?.data?.detail.pr?.number).toBe(2);
    expect(pullDetailKeyFor(repoA, 1)).not.toBe(pullDetailKeyFor(repoA, 2));
  });
});

describe('bounded keyed resources', () => {
  test('evicts least-recently-used entries past the cap, never in-flight ones', async () => {
    const resource = createKeyedAsyncResource<string>({ maxEntries: 3 });
    await resource.refresh('a', async () => 'a');
    await resource.refresh('b', async () => 'b');
    await resource.refresh('c', async () => 'c');
    // Touch `a` so `b` is the eviction candidate.
    resource.getEntry('a');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await resource.refresh('d', async () => 'd');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resource.getEntry('a')?.data).toBe('a');
    expect(resource.getEntry('b')).toBe(null);
    expect(resource.getEntry('c')?.data).toBe('c');
    expect(resource.getEntry('d')?.data).toBe('d');
  });

  test('in-flight entries survive eviction pressure', async () => {
    const resource = createKeyedAsyncResource<string>({ maxEntries: 2 });
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const slow = resource.refresh('slow', async () => gate);
    await resource.refresh('x', async () => 'x');
    await resource.refresh('y', async () => 'y');
    await new Promise((resolve) => setTimeout(resolve, 5));
    release('slow-value');
    const settled = await slow;
    expect(settled.data).toBe('slow-value');
    expect(resource.getEntry('slow')?.data).toBe('slow-value');
  });

  test('subscribed entries survive eviction pressure', async () => {
    const resource = createKeyedAsyncResource<string>({ maxEntries: 2 });
    await resource.refresh('watched', async () => 'watched');
    const unsubscribe = resource.subscribe('watched', () => {});
    await resource.refresh('x', async () => 'x');
    await resource.refresh('y', async () => 'y');
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The subscribed entry is protected; an unsubscribed LRU entry evicts instead.
    expect(resource.getEntry('watched')?.data).toBe('watched');
    unsubscribe();
  });

  test('remote search keeps only the last queries per repo', async () => {
    const { api } = fakeGithub();
    const store = useGitHubPullRequestsStore.getState();
    for (let index = 0; index < 12; index += 1) {
      await store.searchRemote(
        directory, repoA, { state: 'open', involvement: 'all', q: `query-${index}` }, api,
      );
    }
    expect(getPullsRemoteEntry(repoA, { state: 'open', involvement: 'all', q: 'query-11' })?.data).not.toBe(null);
    expect(getPullsRemoteEntry(repoA, { state: 'open', involvement: 'all', q: 'query-0' })).toBe(null);
    // Remote hits still merge into the local index for reselect.
    expect(findPullSeed(repoA, 99)?.number).toBe(99);
    expect(pullsCollectionKeyFor(repoA, 'open')).not.toBe(pullsCollectionKeyFor(repoB, 'open'));
  });
});

describe('shared load-more contract', () => {
  beforeEach(() => {
    useGitHubPullRequestsStore.getState().resetForRuntimeSwitch();
  });

  test('failed collection page keeps items and records the error inline', async () => {
    let failPages = false;
    const { api } = fakeGithub({
      pullsList: (async (_d: string, _r: string, query?: GitHubPullsQuery) => {
        if (failPages && query?.cursor) throw new GitHubAPIError({ kind: 'failed', message: 'boom' }, 502);
        if (query?.cursor) {
          return { repo: {}, items: [prSummary(2)], nextCursor: null, fetchedAt: Date.now() };
        }
        return { repo: {}, items: [prSummary(1)], nextCursor: 'page-2', fetchedAt: Date.now() };
      }) as never,
    });
    const store = useGitHubPullRequestsStore.getState();
    await store.ensureCollection(directory, repoA, 'open', api);
    failPages = true;
    await store.loadMoreCollection(directory, repoA, 'open', api);
    const entry = getPullsCollectionEntry(repoA, 'open');
    expect(entry?.data?.items.map((item) => item.number)).toEqual([1]);
    expect(entry?.data?.nextCursor).toBe('page-2');
    expect(entry?.error?.kind).toBe('failed');
    expect(entry?.stale).toBe(true);
  });

  test('marking collections stale fetches nothing and forces revalidation', async () => {
    const { api, calls } = fakeGithub();
    const store = useGitHubPullRequestsStore.getState();
    await store.ensureCollectionsFresh(directory, repoA, 'both', api);
    const afterLoad = calls.pulls;
    expect(afterLoad).toBeGreaterThan(0);
    store.selectPullRequest(directory, repoA, 1);
    store.notifyAgentTurnComplete(directory);
    // Stale marking alone issues no fetch; the entry just reads stale.
    expect(calls.pulls).toBe(afterLoad);
    expect(getPullsCollectionEntry(repoA, 'open')?.stale).toBe(true);
    expect(getPullsCollectionEntry(repoA, 'closed')?.stale).toBe(true);
    // The next ensure revalidates through the network exactly once per collection.
    await store.ensureCollectionsFresh(directory, repoA, 'both', api);
    expect(calls.pulls).toBeGreaterThan(afterLoad);
    expect(getPullsCollectionEntry(repoA, 'open')?.stale).toBe(false);
    expect(getPullsCollectionEntry(repoA, 'closed')?.stale).toBe(false);
  });
});
