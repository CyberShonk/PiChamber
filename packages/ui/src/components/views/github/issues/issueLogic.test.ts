// GitHub link parsing: shorthand, scoped refs, and URLs against the scope allow-list.
import { describe, expect, test } from 'bun:test';
import { parseGitHubLinkInput } from './issueLogic';

const scopeRepos = [
  { owner: 'octocat', repo: 'hello-world', ref: 'github.com/octocat/hello-world' },
  { owner: 'octocat', repo: 'other', ref: 'github.com/octocat/other' },
];

describe('parseGitHubLinkInput', () => {
  test('parses shorthand, scoped refs, and URLs in one table', () => {
    expect(parseGitHubLinkInput('#123', scopeRepos)).toEqual({
      link: { kind: 'issue', number: 123, owner: '', repo: '' },
      outOfScope: false,
    });
    expect(parseGitHubLinkInput('octocat/hello-world#7', scopeRepos).link?.number).toBe(7);
    expect(parseGitHubLinkInput('evil/repo#7', scopeRepos)).toEqual({ link: null, outOfScope: true });
    expect(parseGitHubLinkInput('https://github.com/octocat/other/issues/42', scopeRepos).link).toMatchObject({
      kind: 'issue',
      number: 42,
      owner: 'octocat',
      repo: 'other',
    });
    expect(parseGitHubLinkInput('https://github.com/octocat/hello-world/pull/9', scopeRepos).link).toMatchObject({
      kind: 'pr',
      number: 9,
    });
    expect(parseGitHubLinkInput('https://github.com/octocat/hello-world/pull/9/files', scopeRepos).link).toMatchObject({
      kind: 'pr',
      number: 9,
    });
    expect(parseGitHubLinkInput('https://github.com/evil/repo/issues/1', scopeRepos).outOfScope).toBe(true);
    expect(parseGitHubLinkInput('some search text', scopeRepos)).toEqual({ link: null, outOfScope: false });
    expect(parseGitHubLinkInput('', scopeRepos)).toEqual({ link: null, outOfScope: false });
  });
});
