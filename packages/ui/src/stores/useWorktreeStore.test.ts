import { beforeEach, describe, expect, test } from 'bun:test';

import type { GitAPI, GitWorktree } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { WORKTREE_REFRESH_FRESHNESS_MS, buildAvailableWorktreesByProject, useWorktreeStore } from './useWorktreeStore';

const worktrees: GitWorktree[] = [
  { path: '/repo', branch: 'main', head: 'a', name: 'repo', isPrimary: true, detached: false, locked: false, prunable: false },
  { path: '/worktrees/task', branch: 'pichamber/task', head: 'b', name: 'task', isPrimary: false, detached: false, locked: false, prunable: false },
];

const git = (overrides: Partial<GitAPI> = {}): GitAPI => ({
  checkIsGitRepository: async () => true,
  listGitWorktrees: async () => worktrees,
  ...overrides,
} as GitAPI);

describe('worktree store', () => {
  beforeEach(() => {
    useWorktreeStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('discovers worktrees and exposes only valid linked entries', async () => {
    await useWorktreeStore.getState().refreshProject('/repo', git());
    const available = buildAvailableWorktreesByProject([{ path: '/repo' }], useWorktreeStore.getState());
    expect(available.get('/repo')).toEqual([worktrees[1]]);
    expect(useWorktreeStore.getState().projects.get('/repo')?.status).toBe('ready');
  });

  test('preserves the previous authoritative list when refresh fails', async () => {
    await useWorktreeStore.getState().refreshProject('/repo', git());
    // Forced: the immediate retry must reach the network, not the freshness window.
    await useWorktreeStore.getState().refreshProject('/repo', git({
      listGitWorktrees: async () => { throw new Error('offline'); },
    }), { force: true });

    const state = useWorktreeStore.getState().projects.get('/repo');
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('offline');
    expect(state?.worktrees).toEqual(worktrees);
  });

  test('records a successful empty result for a non-repository', async () => {
    await useWorktreeStore.getState().refreshProject('/plain', git({ checkIsGitRepository: async () => false }));
    const state = useWorktreeStore.getState().projects.get('/plain');
    expect(state?.status).toBe('ready');
    expect(state?.worktrees).toEqual([]);
  });

  test('skips the network inside the freshness window', async () => {
    let checkCalls = 0;
    let listCalls = 0;
    const counting = git({
      checkIsGitRepository: async () => { checkCalls += 1; return true; },
      listGitWorktrees: async () => { listCalls += 1; return worktrees; },
    });
    const first = await useWorktreeStore.getState().refreshProject('/repo', counting);
    expect(first).toEqual(worktrees);
    const second = await useWorktreeStore.getState().refreshProject('/repo', counting);
    expect(second).toEqual(worktrees);
    expect(checkCalls).toBe(1);
    expect(listCalls).toBe(1);
  });

  test('force bypasses the freshness window', async () => {
    let listCalls = 0;
    const counting = git({
      listGitWorktrees: async () => { listCalls += 1; return worktrees; },
    });
    await useWorktreeStore.getState().refreshProject('/repo', counting);
    const forced = await useWorktreeStore.getState().refreshProject('/repo', counting, { force: true });
    expect(forced).toEqual(worktrees);
    expect(listCalls).toBe(2);
  });

  test('stale successes refetch after the freshness window', async () => {
    let listCalls = 0;
    const counting = git({
      listGitWorktrees: async () => { listCalls += 1; return worktrees; },
    });
    await useWorktreeStore.getState().refreshProject('/repo', counting);
    const current = useWorktreeStore.getState().projects.get('/repo');
    expect(current?.status).toBe('ready');
    useWorktreeStore.setState((state) => {
      const projects = new Map(state.projects);
      projects.set('/repo', { ...current!, fetchedAt: Date.now() - WORKTREE_REFRESH_FRESHNESS_MS - 1 });
      return { projects };
    });
    await useWorktreeStore.getState().refreshProject('/repo', counting);
    expect(listCalls).toBe(2);
  });

  test('failed refreshes never count as fresh', async () => {
    let listCalls = 0;
    const flapping = git({
      listGitWorktrees: async () => {
        listCalls += 1;
        if (listCalls === 1) throw new Error('offline');
        return worktrees;
      },
    });
    await useWorktreeStore.getState().refreshProject('/repo', flapping);
    expect(useWorktreeStore.getState().projects.get('/repo')?.status).toBe('failed');
    await useWorktreeStore.getState().refreshProject('/repo', flapping);
    expect(useWorktreeStore.getState().projects.get('/repo')?.status).toBe('ready');
    expect(listCalls).toBe(2);
  });
});
