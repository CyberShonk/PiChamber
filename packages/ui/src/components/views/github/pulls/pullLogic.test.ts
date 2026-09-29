// PR action gates: state impossibility outranks permissions; author exception; read gate for comments.
import { describe, expect, test } from 'bun:test';
import { gatePullAction, gatePullComment, gatePullEdit } from '@/components/views/github/pulls/pullLogic';

describe('pull permission gates', () => {
  test('state impossibility wins, then push access, with an author exception', () => {
    const open = { state: 'open' as const, draft: false, mergeable: true, mergeableState: 'clean' };
    const noPush = { capabilities: { canPush: false, canTriage: false, canPull: true, canComment: true } };
    const push = { capabilities: { canPush: true, canTriage: true, canPull: true, canComment: true } };
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown> | undefined, boolean, string?]> = [
      ['merge', open, push, true],
      ['merge', open, noPush, false, 'You need write access to merge'],
      ['merge', { ...open, draft: true }, push, false, 'Marked as draft'],
      ['merge', { ...open, state: 'merged' }, push, false, 'Already merged'],
      ['reopen', open, push, false, 'Already open'],
      ['reopen', { ...open, state: 'closed' }, noPush, false, 'You need write access or be the author to reopen'],
      ['close', open, noPush, false, 'You need write access or be the author to close'],
      ['ready', open, push, false, 'Already ready for review'],
      ['ready', { ...open, draft: true }, push, true],
      ['update-branch', open, noPush, false, 'You need write access to update the branch'],
      ['squash', { ...open, mergeable: false, mergeableState: 'dirty' }, push, false, 'Has merge conflicts'],
    ];
    for (const [action, pr, perms, allowed, reason] of cases) {
      const result = gatePullAction(action as never, pr as never, perms as never);
      expect(result.allowed).toBe(allowed);
      if (reason) expect(result).toMatchObject({ reason });
    }
    // The author may close/reopen and edit without push access; commenting needs read access.
    expect(gatePullAction('close', open, { ...noPush, isAuthor: true } as never).allowed).toBe(true);
    expect(gatePullAction('reopen', { ...open, state: 'closed' } as never, { ...noPush, isAuthor: true } as never).allowed).toBe(true);
    expect(gatePullEdit(open as never, { ...noPush, isAuthor: true } as never).allowed).toBe(true);
    expect(gatePullEdit(open as never, noPush as never)).toMatchObject({ allowed: false });
    expect(gatePullComment({ capabilities: { canPush: false, canTriage: false, canPull: false, canComment: false } })).toMatchObject({ allowed: false });
    expect(gatePullComment(undefined).allowed).toBe(true);
  });
});
