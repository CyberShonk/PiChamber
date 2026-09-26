import { describe, expect, it } from 'vitest';

import { FULL_ACCEPT, createPullsService } from './pulls.js';
import { createIssuesService } from './issues.js';
import { deriveCapabilities } from './repo-scope.js';
import { createTemplatesService } from './templates.js';

const credential = { host: 'github.com', token: 't', fingerprint: 'fp' };
const repo = { host: 'github.com', owner: 'octocat', repo: 'hello-world' };

const restPull = (number, overrides = {}) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/octocat/hello-world/pull/${number}`,
  state: 'open',
  merged_at: null,
  draft: false,
  base: { ref: 'main' },
  head: { ref: `feature-${number}`, sha: `sha${number}` },
  user: { login: 'octocat', id: 1, avatar_url: 'https://example.com/a.png' },
  labels: [{ name: 'bug', color: 'ff0000' }],
  assignees: [{ login: 'assignee', id: 2, avatar_url: null }],
  requested_reviewers: [{ login: 'reviewer', id: 3, avatar_url: null }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...overrides,
});

const restIssue = (number, overrides = {}) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://github.com/octocat/hello-world/issues/${number}`,
  state: 'open',
  user: { login: 'octocat', id: 1, avatar_url: null },
  labels: [{ name: 'bug', color: 'ff0000' }],
  assignees: [{ login: 'assignee', id: 2, avatar_url: null }],
  comments: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  closed_at: null,
  ...overrides,
});

describe('list summary shape the UI reads', () => {
  it('maps pull summaries body-free with labels, assignees, reviewers, and merged state', async () => {
    const client = {
      request: async (args) => {
        if (args.operation === 'pull request list') {
          return { body: [restPull(1, { draft: true, merged_at: '2026-02-01T00:00:00Z', state: 'closed' })] };
        }
        throw new Error(`unexpected ${args.operation}`);
      },
    };
    const { items } = await createPullsService({ client }).listPulls(credential, repo, { state: 'all' });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).not.toHaveProperty('body');
    expect(item).toMatchObject({
      number: 1,
      state: 'merged',
      draft: true,
      mergedAt: '2026-02-01T00:00:00Z',
      labels: [{ name: 'bug', color: 'ff0000' }],
      assignees: [{ login: 'assignee', id: 2, avatarUrl: null }],
      requestedReviewers: [{ login: 'reviewer', id: 3, avatarUrl: null }],
    });
  });

  it('maps issue summaries with labels and assignees', async () => {
    const client = {
      request: async (args) => {
        if (args.operation === 'issue list') return { body: [restIssue(1)] };
        throw new Error(`unexpected ${args.operation}`);
      },
    };
    const { items } = await createIssuesService({ client }).listIssues(credential, repo, { state: 'all' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      number: 1,
      labels: [{ name: 'bug', color: 'ff0000' }],
      assignees: [{ login: 'assignee', id: 2, avatarUrl: null }],
    });
  });
});

describe('bodyHtml passthrough with the full+json accept header', () => {
  it('requests body_html for PR detail, reviews, and conversation comments and maps bodyHtml', async () => {
    const seen = [];
    const client = {
      request: async (args) => {
        seen.push(args);
        if (args.operation === 'pull request detail') {
          return { body: { number: 1, title: 'T', html_url: '', state: 'open', base: { ref: 'main' }, head: { ref: 'x' }, body: 'md', body_html: '<p>pr</p>' } };
        }
        if (args.operation === 'pull request reviews') {
          return { body: [{ id: 9, state: 'APPROVED', body: 'lgtm', body_html: '<p>lgtm</p>' }] };
        }
        return { body: [] };
      },
      graphql: async () => ({ body: { repository: { pullRequest: { id: 'n', reviewThreads: { nodes: [] } } } } }),
    };
    const pulls = createPullsService({ client });
    const result = await pulls.getPull(credential, repo, 1);
    expect(result.pr.bodyHtml).toBe('<p>pr</p>');
    expect(result.reviews[0].bodyHtml).toBe('<p>lgtm</p>');
    expect(seen.find((args) => args.operation === 'pull request detail').accept).toBe(FULL_ACCEPT);
    expect(seen.find((args) => args.operation === 'pull request reviews').accept).toBe(FULL_ACCEPT);
    expect(FULL_ACCEPT).toBe('application/vnd.github.full+json');

    seen.length = 0;
    await pulls.listPullComments(credential, repo, 1);
    expect(seen[0]).toMatchObject({ accept: FULL_ACCEPT, operation: 'pull request comments' });
  });

  it('requests body_html for issue detail and comments and maps bodyHtml', async () => {
    const seen = [];
    const client = {
      request: async (args) => {
        seen.push(args);
        if (args.operation === 'issue detail') {
          return { body: { number: 1, title: 'T', html_url: '', state: 'open', body: 'md', body_html: '<p>issue</p>' } };
        }
        return { body: [] };
      },
      graphql: async () => ({ body: { repository: { issue: null } } }),
    };
    const issues = createIssuesService({ client });
    const result = await issues.getIssue(credential, repo, 1);
    expect(result.issue.bodyHtml).toBe('<p>issue</p>');
    expect(seen.find((args) => args.operation === 'issue detail').accept).toBe(FULL_ACCEPT);
    seen.length = 0;
    await issues.listComments(credential, repo, 1);
    expect(seen[0]).toMatchObject({ accept: FULL_ACCEPT, operation: 'issue comments' });
  });
});

describe('permission and viewer gating', () => {
  const detailClient = () => ({
    request: async (args) => {
      if (args.operation === 'pull request detail') {
        return { body: { number: 1, title: 'T', html_url: '', state: 'open', base: { ref: 'main' }, head: { ref: 'x' }, user: { login: 'someone' } } };
      }
      if (args.operation === 'issue detail') {
        return { body: { number: 7, title: 'I', html_url: '', state: 'open', user: { login: 'someone' } } };
      }
      if (args.operation === 'pull request reviews') return { body: [] };
      throw new Error(`unexpected request ${args.operation}`);
    },
    graphql: async (args) => {
      if (args.operation === 'review threads') {
        return { body: { repository: { pullRequest: { id: 'n', reviewThreads: { nodes: [] } } } } };
      }
      return { body: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } } } } };
    },
  });

  it('attaches viewerPermission, capabilities, and viewerLogin to PR and issue detail', async () => {
    const pulls = createPullsService({
      client: detailClient(),
      resolveViewer: async () => 'octocat',
      resolvePermission: async () => ({ level: 'triage', fallback: false, capabilities: deriveCapabilities('triage') }),
    });
    const pull = await pulls.getPull(credential, repo, 1);
    expect(pull.viewerPermission).toEqual({ level: 'triage', fallback: false });
    expect(pull.capabilities).toMatchObject({ canPush: false, canComment: true });
    expect(pull.viewerLogin).toBe('octocat');

    const issues = createIssuesService({
      client: detailClient(),
      resolveViewer: async () => 'octocat',
      resolvePermission: async () => ({ level: 'push', fallback: false, capabilities: deriveCapabilities('push') }),
    });
    const issue = await issues.getIssue(credential, repo, 7);
    expect(issue.viewerPermission).toEqual({ level: 'push', fallback: false });
    expect(issue.capabilities).toMatchObject({ canPush: true });
    expect(issue.viewerLogin).toBe('octocat');
  });

  it('falls back permissively when permission resolution fails so controls stay enabled', async () => {
    const pulls = createPullsService({
      client: detailClient(),
      resolveViewer: async () => null,
      resolvePermission: async () => ({ level: null, fallback: true, capabilities: deriveCapabilities(null) }),
    });
    const result = await pulls.getPull(credential, repo, 1);
    expect(result.pr?.number).toBe(1);
    expect(result.viewerPermission).toEqual({ level: null, fallback: true });
    expect(result.viewerLogin).toBe(null);
  });
});

describe('issue templates', () => {
  const encode = (text) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });

  it('lists markdown templates with decoded bodies, skipping YAML forms', async () => {
    const client = {
      request: async (input) => {
        if (input.path.endsWith('/contents/.github/ISSUE_TEMPLATE')) {
          return { body: [
            { type: 'file', name: 'bug.md', path: '.github/ISSUE_TEMPLATE/bug.md' },
            { type: 'file', name: 'config.yml', path: '.github/ISSUE_TEMPLATE/config.yml' },
          ] };
        }
        if (input.path.endsWith('bug.md')) return { body: encode('---\nname: Bug\n---\n\nDescribe the bug.') };
        throw new Error(`unexpected request ${input.path}`);
      },
    };
    const result = await createTemplatesService({ client }).listIssueTemplates(credential, repo);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toMatchObject({ filename: 'bug.md', name: 'Bug' });
  });

  it('keeps readable templates when one file fails and rethrows when the repo is unreadable', async () => {
    const partial = createTemplatesService({
      client: {
        request: async (input) => {
          if (input.path.endsWith('/contents/.github/ISSUE_TEMPLATE')) {
            return { body: [
              { type: 'file', name: 'a.md', path: '.github/ISSUE_TEMPLATE/a.md' },
              { type: 'file', name: 'b.md', path: '.github/ISSUE_TEMPLATE/b.md' },
            ] };
          }
          if (input.path.endsWith('a.md')) return { body: encode('Template A') };
          throw Object.assign(new Error('failed'), { kind: 'failed' });
        },
      },
    });
    const kept = await partial.listIssueTemplates(credential, repo);
    expect(kept.templates.map((template) => template.filename)).toEqual(['a.md']);

    const noAccess = Object.assign(new Error('no-access'), { kind: 'unavailable', reason: 'no-access' });
    const denied = createTemplatesService({ client: { request: async () => { throw noAccess; } } });
    await expect(denied.listIssueTemplates(credential, repo)).rejects.toMatchObject({ reason: 'no-access' });
  });
});
