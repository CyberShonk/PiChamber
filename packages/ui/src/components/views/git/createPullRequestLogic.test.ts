// Create-PR base derivation: fork default, remote stripping, dedupe, head exclusion.
import { describe, expect, test } from 'bun:test';
import { deriveBaseBranchOptions, resolveCreatePrDefaultBase } from './createPullRequestLogic';

describe('create-pr base derivation', () => {
  test('default base prefers upstream on forks, repo default, then main', () => {
    expect(resolveCreatePrDefaultBase({ isFork: true, upstreamDefaultBranch: 'upstream-main', defaultBranch: 'main' })).toBe('upstream-main');
    expect(resolveCreatePrDefaultBase({ isFork: false, upstreamDefaultBranch: 'upstream-main', defaultBranch: 'develop' })).toBe('develop');
    expect(resolveCreatePrDefaultBase({ isFork: false, upstreamDefaultBranch: null, defaultBranch: null })).toBe('main');
    expect(resolveCreatePrDefaultBase({ isFork: true, upstreamDefaultBranch: '  ', defaultBranch: '' })).toBe('main');
  });

  test('base options strip remotes, dedupe, exclude head, and keep default first', () => {
    const all = ['main', 'feature/login', 'remotes/origin/main', 'remotes/origin/develop', 'remotes/upstream/main', 'remotes/origin/feature/login', 'remotes/origin/HEAD'];
    expect(deriveBaseBranchOptions({ allBranches: all, headBranch: 'feature/login', defaultBranch: 'main' })).toEqual(['main', 'develop', 'HEAD']);
    expect(deriveBaseBranchOptions({ allBranches: ['remotes/origin/trunk'], headBranch: 'feature', defaultBranch: 'trunk' })).toEqual(['trunk']);
    expect(deriveBaseBranchOptions({ allBranches: ['remotes/origin/other'], headBranch: 'feature', defaultBranch: 'local-only' })).toEqual(['local-only', 'other']);
    expect(deriveBaseBranchOptions({ allBranches: null, headBranch: 'feature', defaultBranch: 'main' })).toEqual([]);
    expect(deriveBaseBranchOptions({ allBranches: ['main', 'feature'], headBranch: 'feature', defaultBranch: null })).toEqual([]);
    expect(
      deriveBaseBranchOptions({
        allBranches: ['remotes/', 'remotes/origin', 'remotes/origin/  ', 'remotes/origin/valid'],
        headBranch: 'feature',
        defaultBranch: null,
      }),
    ).toEqual(['valid']);
  });
});
