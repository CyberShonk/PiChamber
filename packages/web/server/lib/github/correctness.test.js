import { describe, expect, it, vi } from 'vitest';

import { unavailable } from './errors.js';
import { createCredentialStore, fingerprintToken } from './credential.js';
import { createChecksService } from './checks.js';
import { buildIssueContext, buildPullContext } from './context.js';
import { createIssuesService } from './issues.js';
import { createPullsService } from './pulls.js';
import { createRepoScopeResolver } from './repo-scope.js';
import { registerGitHubRoutes } from './routes.js';

const credential = { host: 'github.com', token: 't', fingerprint: 'fp' };
const repo = { host: 'github.com', owner: 'octocat', repo: 'hello-world' };

const closedPull = (number, mergedAt = null) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/octocat/hello-world/pull/${number}`,
  state: 'closed',
  merged_at: mergedAt,
  draft: false,
  base: { ref: 'main' },
  head: { ref: `feature-${number}`, sha: `sha${number}` },
  user: { login: 'octocat' },
  labels: [],
  assignees: [],
  requested_reviewers: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
});

describe('fetch failures never read as authoritative empty', () => {
  it('surfaces PR review/thread failures in sectionErrors instead of empty lists', async () => {
    const client = {
      request: async (args) => {
        if (args.operation === 'pull request detail') {
          return { body: { number: 1, title: 'T', html_url: '', state: 'open', base: { ref: 'main' }, head: { ref: 'x' } } };
        }
        if (args.operation === 'pull request reviews') throw unavailable('no-access');
        throw new Error(`unexpected request ${args.operation}`);
      },
      graphql: async () => { throw unavailable('no-access'); },
    };
    const result = await createPullsService({ client }).getPull(credential, repo, 1);
    expect(result.reviews).toEqual([]);
    expect(result.threads).toEqual([]);
    expect(result.sectionErrors?.reviews?.kind).toBe('unavailable');
    expect(result.sectionErrors?.threads?.kind).toBe('unavailable');
  });

  it('surfaces a single failed checks source but fails the whole read when both fail', async () => {
    const partial = createChecksService({
      client: {
        request: async (args) => {
          if (args.operation === 'check runs') throw unavailable('no-access');
          return { body: [{ id: 1, context: 'ci', state: 'success' }] };
        },
      },
    });
    const result = await partial.getChecks(credential, repo, 'abc123', {});
    expect(result.sectionErrors?.runs?.kind).toBe('unavailable');
    expect(result.sectionErrors?.statuses).toBe(undefined);

    const total = createChecksService({ client: { request: async () => { throw unavailable('no-access'); } } });
    await expect(total.getChecks(credential, repo, 'abc123', {})).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('surfaces linked-PR GraphQL failure as a section error while the issue still loads', async () => {
    const issues = createIssuesService({
      client: {
        request: async (args) => {
          if (args.operation === 'issue detail') return { body: { number: 7, title: 'I', html_url: '', state: 'open' } };
          throw new Error(`unexpected request ${args.operation}`);
        },
        graphql: async () => { throw unavailable('no-access'); },
      },
      resolvePermission: async () => ({ level: 'pull', fallback: false, capabilities: { canPush: false, canTriage: false, canPull: true, canComment: true } }),
    });
    const result = await issues.getIssue(credential, repo, 7);
    expect(result.issue?.number).toBe(7);
    expect(result.linkedPullRequests).toEqual([]);
    expect(result.sectionErrors?.linkedPullRequests).toMatchObject({ kind: 'unavailable', reason: 'no-access' });
  });

  it('propagates comment-list failures instead of returning empty comments', async () => {
    const pulls = createPullsService({ client: { request: async () => { throw unavailable('no-access'); } } });
    await expect(pulls.listPullComments(credential, repo, 12))
      .rejects.toMatchObject({ kind: 'unavailable', reason: 'no-access' });
  });

  it('marks unloadable agent-context sections with a Note instead of empty text', () => {
    const issue = buildIssueContext({
      repo,
      issue: { number: 1, title: 'T', state: 'open', url: '', labels: [] },
      comments: [],
      warnings: ['Comments could not be loaded (boom)'],
    });
    expect(issue.text).toContain('Note: Comments could not be loaded (boom)');
    const pull = buildPullContext({
      repo,
      pr: { number: 1, title: 'T', state: 'open', head: 'x', base: 'main', url: '' },
      files: [],
      warnings: ['Changed files could not be loaded (boom)'],
    });
    expect(pull.text).toContain('Note: Changed files could not be loaded (boom)');
    const clean = buildIssueContext({
      repo,
      issue: { number: 1, title: 'T', state: 'open', url: '', labels: [] },
      comments: [],
    });
    expect(clean.text).not.toContain('Note:');
  });
});

describe('cache stores only successes, partitioned per account', () => {
  it('coalesces concurrent reads into one upstream call', async () => {
    let reads = 0;
    const pulls = createPullsService({
      client: {
        request: async () => {
          reads += 1;
          return { body: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@' }] };
        },
      },
    });
    const [first, second] = await Promise.all([
      pulls.listFiles(credential, repo, 12),
      pulls.listFiles(credential, repo, 12),
    ]);
    expect(first.files).toHaveLength(1);
    expect(second.files).toHaveLength(1);
    expect(reads).toBe(1);
  });

  it('never caches failures and partitions the viewer cache by account', async () => {
    const store = createCredentialStore({ ghCli: { getToken: async () => 't' } });
    const cred = { host: 'github.com', token: 't', fingerprint: fingerprintToken('github.com', 't') };
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ login: 'octocat' });
    await expect(store.getViewer(cred, loader)).rejects.toThrow('boom');
    await expect(store.getViewer(cred, loader)).resolves.toEqual({ login: 'octocat' });
    expect(loader).toHaveBeenCalledTimes(2);

    const partitioned = createCredentialStore({ ghCli: { getToken: async () => 't' } });
    const perAccount = vi.fn(async () => ({ login: 'octocat' }));
    await partitioned.getViewer(
      { host: 'github.com', token: 'one', fingerprint: fingerprintToken('github.com', 'one') },
      perAccount,
    );
    await partitioned.getViewer(
      { host: 'github.com', token: 'two', fingerprint: fingerprintToken('github.com', 'two') },
      perAccount,
    );
    expect(perAccount).toHaveBeenCalledTimes(2);
  });

  it('a posted comment is visible on the immediate re-read', async () => {
    let reads = 0;
    const comment = (id) => ({
      id,
      body: `comment ${id}`,
      user: { login: 'octocat' },
      created_at: '2024-01-01T00:00:00Z',
      updated_at: null,
      html_url: 'https://example.com/c',
    });
    const pulls = createPullsService({
      client: {
        request: async (args) => {
          if (args.method === 'POST') return { body: comment(99) };
          reads += 1;
          return { body: [comment(1)] };
        },
      },
    });
    await pulls.listPullComments(credential, repo, 12);
    await pulls.listPullComments(credential, repo, 12);
    expect(reads).toBe(1);
    await pulls.postComment(credential, repo, 12, { body: 'hello' });
    const after = await pulls.listPullComments(credential, repo, 12);
    expect(reads).toBe(2);
    expect(after.comments).toHaveLength(1);
  });
});

describe('route layer never reports failure as an empty list', () => {
  it('maps list failures to taxonomy errors with no items shape', async () => {
    const routes = new Map();
    const app = {
      get: (path, handler) => { routes.set(`GET ${path}`, handler); },
      post: (path, handler) => { routes.set(`POST ${path}`, handler); },
      patch: (path, handler) => { routes.set(`PATCH ${path}`, handler); },
      delete: (path, handler) => { routes.set(`DELETE ${path}`, handler); },
    };
    const scope = {
      directory: '/repo',
      repositories: [{ kind: 'containing', host: 'github.com', owner: 'octocat', repo: 'hello-world' }],
    };
    const realScope = createRepoScopeResolver();
    registerGitHubRoutes(app, {
      scopeResolver: { ...realScope, resolveScope: async () => structuredClone(scope), invalidate: () => {} },
      credential: {
        withPinnedCredential: async (host, task) => task({ host, token: 't', fingerprint: 'fp' }),
        getViewer: async () => null,
        invalidateViewer: () => {},
      },
      issues: { listIssues: async () => { throw unavailable('gh-unauthenticated'); } },
    });
    const handler = routes.get('GET /api/github/issues');
    let statusCode = 200;
    let payload = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; },
    };
    await handler({ query: { directory: '/repo', repo: 'github.com/octocat/hello-world' }, params: {}, body: {} }, res);
    expect(statusCode).toBe(503);
    expect(payload.items).toBeUndefined();
    expect(payload.error.reason).toBe('gh-unauthenticated');
  });
});

describe('pagination cursors', () => {
  it('drives nextCursor from the effective page size', async () => {
    const items = (count) => Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      html_url: '',
      state: 'open',
      user: { login: 'octocat' },
      labels: [],
      assignees: [],
      comments: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      closed_at: null,
    }));
    const client = {
      request: async (args) => {
        if (args.operation === 'issue list') return { body: items(3) };
        throw new Error(`unexpected ${args.operation}`);
      },
    };
    const issues = createIssuesService({ client });
    const full = await issues.listIssues(credential, repo, { perPage: 3 });
    expect(full.nextCursor).toBe('2');
    const short = await issues.listIssues(credential, repo, { perPage: 10 });
    expect(short.nextCursor).toBe(null);
  });

  it('state=merged advances from the raw closed page so filtered-empty pages keep paging', async () => {
    const serviceFor = (items) => createPullsService({
      client: {
        request: async (args) => {
          if (args.operation === 'pull request list') return { body: items };
          throw new Error(`unexpected ${args.operation}`);
        },
      },
    });
    const empty = await serviceFor([closedPull(1), closedPull(2), closedPull(3)]).listPulls(credential, repo, { state: 'merged', perPage: 3 });
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBe('2');
    const short = await serviceFor([closedPull(1), closedPull(2)]).listPulls(credential, repo, { state: 'merged', perPage: 5 });
    expect(short.nextCursor).toBe(null);
    const merged = await serviceFor([
      closedPull(1, '2026-02-01T00:00:00Z'),
      closedPull(2),
      closedPull(3, '2026-02-02T00:00:00Z'),
    ]).listPulls(credential, repo, { state: 'merged', perPage: 3 });
    expect(merged.items.map((item) => item.number)).toEqual([1, 3]);
    expect(merged.items.every((item) => item.state === 'merged')).toBe(true);
    expect(merged.nextCursor).toBe('2');
  });
});

describe('route input validation', () => {
  it.each([
    ['pull state', (pulls) => pulls.listPulls(credential, repo, { state: 'bogus' })],
    ['pull filter', (pulls) => pulls.listPulls(credential, repo, { filter: 'bogus' })],
    ['pull sort', (pulls) => pulls.listPulls(credential, repo, { sort: 'bogus' })],
    ['issue state', (pulls, issues) => issues.listIssues(credential, repo, { state: 'merged' })],
    ['issue filter', (pulls, issues) => issues.listIssues(credential, repo, { filter: 'review' })],
    ['pull perPage', (pulls) => pulls.listPulls(credential, repo, { perPage: 101 })],
    ['issue perPage', (pulls, issues) => issues.listIssues(credential, repo, { perPage: 0 })],
    ['pull number', (pulls) => pulls.listPullComments(credential, repo, 'abc')],
    ['comment cursor', (pulls) => pulls.listPullComments(credential, repo, 12, { cursor: 'bogus' })],
    ['branch cap', (pulls) => pulls.findPullForBranch(credential, repo, { branch: 'x'.repeat(301) })],
    ['thread id empty', (pulls) => pulls.setThreadResolved(credential, repo, 1, '', true)],
    ['thread id cap', (pulls) => pulls.setThreadResolved(credential, repo, 1, 'x'.repeat(201), true)],
  ])('rejects %s with a 400 input error', async (_label, run) => {
    const stub = {
      request: async (args) => {
        if (args.operation === 'pull request list') return { body: [] };
        if (args.operation === 'issue list') return { body: [] };
        return { body: [] };
      },
      graphql: async () => ({ body: {} }),
    };
    const pulls = createPullsService({ client: stub });
    const issues = createIssuesService({ client: stub });
    await expect(run(pulls, issues)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts the documented states, filters, sorts, and page sizes', async () => {
    const stub = {
      request: async (args) => {
        if (args.operation === 'pull request list') return { body: [] };
        if (args.operation === 'issue list') return { body: [] };
        if (args.operation === 'pull request search' || args.operation === 'issue search') return { body: { items: [] } };
        return { body: [] };
      },
    };
    const pulls = createPullsService({ client: stub });
    const issues = createIssuesService({ client: stub });
    for (const state of ['open', 'closed', 'merged', 'all']) {
      await expect(pulls.listPulls(credential, repo, { state })).resolves.toBeDefined();
    }
    for (const filter of ['all', 'mine', 'assigned', 'mentioned']) {
      await expect(issues.listIssues(credential, repo, { filter, q: filter === 'all' ? '' : 'x' })).resolves.toBeDefined();
    }
    await pulls.listPulls(credential, repo, { perPage: 50 });
    await expect(pulls.listPulls(credential, repo, { perPage: 0 })).rejects.toMatchObject({ statusCode: 400 });
  });
});
