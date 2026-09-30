import { describe, expect, mock, test } from 'bun:test';

// Self-contained: both stores are fully mocked (per-file isolation), the
// topology helper and project resolution stay real.
const refreshCalls: Array<{ root: string; options: unknown }> = [];
const fakeGit = { listGitWorktrees: async () => [] };

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: { getState: () => ({ projects: [] }) },
}));
mock.module('@/stores/useWorktreeStore', () => ({
  buildAvailableWorktreesByProject: () => new Map(),
  useWorktreeStore: {
    getState: () => ({
      projects: new Map(),
      refreshProject: async (root: string, _git: unknown, options?: { force?: boolean }) => {
        refreshCalls.push({ root, options });
        return [];
      },
    }),
  },
}));

const { refreshWorktreeTopology } = await import('./refreshWorktreeTopology');

describe('refreshWorktreeTopology', () => {
  test('forces the refresh past the background freshness window', async () => {
    refreshCalls.length = 0;
    await refreshWorktreeTopology('/repo', fakeGit as never);
    // No registered project owns /repo, so the directory itself is refreshed —
    // with force, since this follows an explicit create/switch mutation.
    expect(refreshCalls).toEqual([{ root: '/repo', options: { force: true } }]);
  });
});
