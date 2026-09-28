// Worktree regression: project worktrees re-list before the draft opens.
import { describe, expect, test } from 'bun:test';
import { startSessionFromGitHubItem, type StartSessionDeps } from './useStartSessionFromGitHubItem';

const draftCalls: Array<Record<string, unknown>> = [];

const baseDeps = (): StartSessionDeps => ({
  github: {
    agentContext: async () => ({ kind: 'issue', text: 'quoted issue context', repo: {}, number: 12, fetchedAt: 0 }),
  } as never,
  git: {
    getGitBranches: async () => ({ current: 'main' }) as never,
    createGitWorktree: (async () => ({ path: '/work/issue-12-crash' })) as never,
  },
  openDraft: ((options: Record<string, unknown>) => {
    draftCalls.push(options);
  }) as never,
});

describe('startSessionFromGitHubItem', () => {
  test('new worktree re-lists the project worktrees before opening the draft', async () => {
    // Regression: the sidebar only showed the new worktree after a later
    // background discovery pass because nothing refreshed the worktree store.
    draftCalls.length = 0;
    const order: string[] = [];
    const deps = baseDeps();
    deps.refreshWorktrees = async (directory) => {
      order.push(`refresh:${directory}`);
    };
    const openDraft = deps.openDraft;
    deps.openDraft = (options) => {
      order.push('draft');
      openDraft?.(options);
    };
    const result = await startSessionFromGitHubItem(
      {
        directory: '/repo',
        repo: 'github.com/o/r',
        number: 12,
        kind: 'issue',
        title: 'Crash on launch!',
        url: 'https://github.com/o/r/issues/12',
        target: 'worktree',
      },
      deps,
    );
    expect(result).toEqual({ ok: true, directory: '/work/issue-12-crash' });
    expect(order).toEqual(['refresh:/repo', 'draft']);
    expect(draftCalls).toHaveLength(1);
  });

  test('leftover branch attaches with mode existing instead of recreating', async () => {
    // Regression: removing a worktree leaves its branch behind, so re-opening
    // the same item must attach the leftover branch instead of mode 'new'.
    draftCalls.length = 0;
    const branchName = 'issue-12-crash-on-launch';
    const createCalls: Array<unknown> = [];
    const deps = baseDeps();
    deps.git = {
      getGitBranches: (async () => ({ current: 'main', all: ['main', branchName] })) as never,
      listGitWorktrees: (async () => []) as never,
      createGitWorktree: (async (_directory: string, input: unknown) => {
        createCalls.push(input);
        return { path: '/work/issue-12-crash' };
      }) as never,
    };
    deps.refreshWorktrees = async () => {};
    const result = await startSessionFromGitHubItem(
      {
        directory: '/repo',
        repo: 'github.com/o/r',
        number: 12,
        kind: 'issue',
        title: 'Crash on launch!',
        url: 'https://github.com/o/r/issues/12',
        target: 'worktree',
      },
      deps,
    );
    expect(result).toEqual({ ok: true, directory: '/work/issue-12-crash' });
    expect(createCalls).toEqual([{ mode: 'existing', existingBranch: branchName }]);
    expect(draftCalls).toHaveLength(1);
  });
});
