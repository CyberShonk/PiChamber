// Local list views: state split, text/#number search, label qualifiers, paging dedupe.
import { describe, expect, test } from 'bun:test';
import {
  applyIssueStateView,
  applyPullStateView,
  filterIssueItems,
  filterPullItems,
  mergeCommentsById,
  parseNumberQuery,
  type IssueItem,
  type PullItem,
} from './githubListFiltering';

const pull = (overrides: Partial<PullItem> & { number: number }): PullItem => ({
  title: `PR ${overrides.number}`,
  url: `https://github.com/o/r/pull/${overrides.number}`,
  state: 'open',
  draft: false,
  base: 'main',
  head: `feature-${overrides.number}`,
  author: { login: 'octocat' },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-02-01T00:00:00Z',
  ...overrides,
});

const issue = (overrides: Partial<IssueItem> & { number: number }): IssueItem => ({
  title: `Issue ${overrides.number}`,
  url: `https://github.com/o/r/issues/${overrides.number}`,
  state: 'open',
  author: { login: 'octocat' },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-02-01T00:00:00Z',
  ...overrides,
});

describe('github list filtering', () => {
  test('number jump accepts #123 and bare digits, rejects the rest', () => {
    const cases: Array<[string, number | null]> = [
      ['#123', 123],
      ['123', 123],
      ['  #7  ', 7],
      ['', null],
      ['fix login', null],
      ['#12a', null],
      ['#0', null],
    ];
    for (const [input, expected] of cases) {
      expect(parseNumberQuery(input)).toBe(expected);
    }
  });

  test('state views split open, closed, merged, and all', () => {
    const pulls = [
      pull({ number: 1, state: 'open' }),
      pull({ number: 2, state: 'closed' }),
      pull({ number: 3, state: 'merged' }),
      pull({ number: 4, state: 'closed', mergedAt: '2024-03-01T00:00:00Z' }),
    ];
    expect(applyPullStateView(pulls, 'open').map((item) => item.number)).toEqual([1]);
    expect(applyPullStateView(pulls, 'closed').map((item) => item.number)).toEqual([2]);
    expect(applyPullStateView(pulls, 'merged').map((item) => item.number)).toEqual([3, 4]);
    expect(applyPullStateView(pulls, 'all')).toHaveLength(4);
    const issues = [issue({ number: 1 }), issue({ number: 2, state: 'closed' })];
    expect(applyIssueStateView(issues, 'open').map((item) => item.number)).toEqual([1]);
    expect(applyIssueStateView(issues, 'closed').map((item) => item.number)).toEqual([2]);
    expect(applyIssueStateView(issues, 'all')).toHaveLength(2);
  });

  test('pull search matches across title, number, author, branch, and labels', () => {
    const items = [
      pull({ number: 1, title: 'Fix login redirect', head: 'fix-login', author: { login: 'ryder' } }),
      pull({ number: 2, title: 'Slow dashboard query', head: 'perf-dash', author: { login: 'teammate' } }),
      pull({ number: 3, title: 'Fix login mobile', head: 'fix-mobile', state: 'closed', labels: [{ name: 'bug' }] }),
    ];
    const base = { state: 'open' as const, involvement: 'all' as const, search: '', sort: 'updated' as const, viewerLogin: 'ryder' };
    const cases: Array<[string, number[]]> = [
      ['fix login', [1]],
      ['ryder', [1]],
      ['perf-dash', [2]],
      ['#2', [2]],
      ['fix dashboard', []],
      ['label:bug', []],
    ];
    for (const [search, expected] of cases) {
      expect(filterPullItems(items, { ...base, search }).map((item) => item.number)).toEqual(expected);
    }
    expect(
      filterPullItems(items, { ...base, state: 'closed', search: 'label:bug' }).map((item) => item.number),
    ).toEqual([3]);
    expect(
      filterPullItems(items, { ...base, involvement: 'mine', search: 'fix' }).map((item) => item.number),
    ).toEqual([1]);
  });

  test('issue search matches title, labels, and #number', () => {
    const items = [
      issue({ number: 1, title: 'Crash on launch', labels: [{ name: 'bug' }] }),
      issue({ number: 2, title: 'Dark mode request', labels: [{ name: 'enhancement' }] }),
    ];
    const base = { state: 'open' as const, involvement: 'all' as const, labels: '', search: '', sort: 'updated' as const, viewerLogin: null };
    expect(filterIssueItems(items, { ...base, search: 'dark' }).map((item) => item.number)).toEqual([2]);
    expect(filterIssueItems(items, { ...base, search: '#1 crash' }).map((item) => item.number)).toEqual([1]);
    expect(filterIssueItems(items, { ...base, labels: 'bug' }).map((item) => item.number)).toEqual([1]);
  });

  test('comment paging appends without duplicating or reordering ids', () => {
    expect(mergeCommentsById([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]).map((comment) => comment.id)).toEqual([1, 2, 3]);
    const base = [{ id: 1 }];
    expect(mergeCommentsById(base, [])).toBe(base);
  });
});
