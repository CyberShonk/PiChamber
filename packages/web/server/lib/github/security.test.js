import { describe, expect, it, vi } from 'vitest';

import { containsSecret, redactSecrets } from './errors.js';
import { createGitHubClient } from './client.js';
import { createCredentialStore, fingerprintToken } from './credential.js';
import { createGhCli } from './gh-cli.js';
import { createRepoScopeResolver, parseRemoteUrl, redactRemoteUrl } from './repo-scope.js';
import { registerGitHubRoutes } from './routes.js';

const SECRET = 'gho_security_test_secret_0123456789';
const HOST = 'github.com';
const credentialFor = (token = SECRET) => ({ host: HOST, token, fingerprint: fingerprintToken(HOST, token) });

const jsonResponse = ({ status = 200, body = {}, headers = {} } = {}) => ({
  status,
  headers: new Headers({ 'content-type': 'application/json', ...headers }),
  text: async () => JSON.stringify(body),
});

describe('secret redaction', () => {
  it('redacts every occurrence and detects leaks, ignoring short values', () => {
    const text = `token=${SECRET} then ${SECRET} again`;
    const redacted = redactSecrets(text, [SECRET]);
    expect(redacted).not.toContain(SECRET);
    expect(containsSecret(redacted, [SECRET])).toBe(false);
    expect(containsSecret(text, [SECRET])).toBe(true);
    expect(containsSecret({ nested: [SECRET] }, [SECRET])).toBe(true);
    expect(redactSecrets('abc', ['abc'])).toBe('abc');
  });

  it('never leaks the token in client errors, responses, or route bodies', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      status: 422,
      body: { message: `echo ${SECRET} rejected`, errors: [{ message: SECRET }] },
    }));
    const client = createGitHubClient({ fetchImpl });
    const error = await client.request({ credential: credentialFor(), host: HOST, method: 'GET', path: '/user', operation: 'test' }).catch((e) => e);
    expect(containsSecret(error.message, [SECRET])).toBe(false);
    expect(containsSecret(JSON.stringify(error), [SECRET])).toBe(false);
  });
});

describe('remote URLs with credentials', () => {
  it.each([
    ['https://github.com/octocat/hello-world.git', { host: 'github.com', owner: 'octocat', repo: 'hello-world' }],
    ['https://user:pass@github.com/octocat/hello-world.git', { host: 'github.com', owner: 'octocat', repo: 'hello-world' }],
    ['git@github.com:octocat/hello-world.git', { host: 'github.com', owner: 'octocat', repo: 'hello-world' }],
    ['ssh://git@github.com:22/octocat/hello-world.git', { host: 'github.com', owner: 'octocat', repo: 'hello-world' }],
  ])('parses %s without keeping credentials', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected);
  });

  it.each(['', 'not-a-url', 'https://github.com/octocat', '/local/path/to/repo'])('rejects %s', (url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });

  it('strips userinfo before a remote URL leaves the server', () => {
    const redacted = redactRemoteUrl('https://user:secret@github.com/octocat/repo.git');
    expect(redacted).not.toContain('user');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('github.com/octocat/repo.git');
    expect(redactRemoteUrl('')).toBeNull();
  });
});

describe('unsupported hosts', () => {
  it('rejects non-github.com hosts without touching the network', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = createGitHubClient({ fetchImpl });
    await expect(client.request({ credential: credentialFor(), host: 'ghe.example.com', method: 'GET', path: '/user', operation: 'test' }))
      .rejects.toMatchObject({ kind: 'unavailable', reason: 'not-github' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const SCOPE = {
  directory: '/repo',
  topLevel: '/repo',
  branch: 'feature-x',
  repositories: [
    {
      kind: 'containing', path: '/repo', relativePath: '.', host: 'github.com',
      owner: 'octocat', repo: 'hello-world', remote: 'origin', submodule: false, fork: false,
    },
  ],
  truncated: false,
  defaultSelection: 'github.com/octocat/hello-world',
  fetchedAt: 0,
};

const createHarness = ({ pulls = {}, scope = SCOPE } = {}) => {
  const routes = new Map();
  const app = {
    get: (path, handler) => { routes.set(`GET ${path}`, handler); },
    post: (path, handler) => { routes.set(`POST ${path}`, handler); },
    patch: (path, handler) => { routes.set(`PATCH ${path}`, handler); },
    delete: (path, handler) => { routes.set(`DELETE ${path}`, handler); },
  };
  const realScope = createRepoScopeResolver();
  registerGitHubRoutes(app, {
    scopeResolver: { ...realScope, resolveScope: async () => structuredClone(scope), invalidate: () => {} },
    credential: {
      withPinnedCredential: async (host, task) => task({ host, token: SECRET, fingerprint: 'fp-test' }),
      getViewer: async () => 'octocat',
      invalidateViewer: () => {},
    },
    pulls: {
      listPulls: async () => ({ items: [] }),
      getPull: async () => ({ pr: null }),
      listPullComments: async () => ({ comments: [], nextCursor: null }),
      listFiles: async () => ({ files: [] }),
      getPullHeadSha: async () => 'abc123',
      invalidate: () => {},
      ...pulls,
    },
  });
  const call = async (method, path, { query = {}, params = {}, body = {} } = {}) => {
    const handler = routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`no route ${method} ${path}`);
    let statusCode = 200;
    let payload = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; },
    };
    await handler({ query, params, body }, res);
    return { statusCode, payload };
  };
  return { call };
};

describe('repo allow-list', () => {
  it('serves allow-listed repos case-insensitively and rejects anything else', async () => {
    const listPulls = vi.fn(async () => ({ items: [] }));
    const { call } = createHarness({ pulls: { listPulls } });
    const ok = await call('GET', '/api/github/pulls', {
      query: { directory: '/repo', repo: 'github.com/Octocat/Hello-World' },
    });
    expect(ok.statusCode).toBe(200);
    expect(listPulls).toHaveBeenCalledTimes(1);
    const denied = await call('GET', '/api/github/pulls', {
      query: { directory: '/repo', repo: 'github.com/evil/victim' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.payload).toEqual({ error: { kind: 'unavailable', reason: 'no-access' } });
    // The service is never reached for an out-of-scope repo.
    expect(listPulls).toHaveBeenCalledTimes(1);
  });

  it('requires directory and well-formed repo params', async () => {
    const { call } = createHarness();
    expect((await call('GET', '/api/github/pulls', { query: { repo: 'github.com/octocat/hello-world' } })).statusCode).toBe(400);
    expect((await call('GET', '/api/github/pulls', { query: { directory: '/repo' } })).statusCode).toBe(400);
    expect((await call('GET', '/api/github/pulls', { query: { directory: '/repo', repo: 'nope' } })).statusCode).toBe(400);
  });

  it('matches scope entries and rejects unknown refs without git', async () => {
    const resolver = createRepoScopeResolver();
    const scope = {
      directory: '/repo',
      repositories: [{ kind: 'containing', host: 'github.com', owner: 'octocat', repo: 'hello-world' }],
    };
    expect(resolver.matchAllowedRepo(scope, 'github.com/Octocat/Hello-World')).toBeTruthy();
    expect(resolver.matchAllowedRepo(scope, 'github.com/octocat/other')).toBeNull();
    expect(resolver.matchAllowedRepo(scope, 'not a ref')).toBeNull();
  });

  it('maps taxonomy errors to HTTP statuses without secrets', async () => {
    for (const [reason, status] of [['gh-unauthenticated', 503], ['no-access', 404]]) {
      const { call } = createHarness({ pulls: { listPulls: async () => { throw (await import('./errors.js')).unavailable(reason); } } });
      const { statusCode, payload } = await call('GET', '/api/github/pulls', {
        query: { directory: '/repo', repo: 'github.com/octocat/hello-world' },
      });
      expect(statusCode).toBe(status);
      expect(payload).toEqual({ error: { kind: 'unavailable', reason } });
      expect(containsSecret(JSON.stringify(payload), [SECRET])).toBe(false);
    }
  });
});

describe('gh CLI is the only credential source', () => {
  const createFakeExec = ({ token = SECRET } = {}) => {
    const calls = [];
    const execFileAsync = vi.fn(async (binary, args) => {
      calls.push({ binary, args });
      if (args[0] === '--version') return { stdout: 'gh version 2.46.0 (2025-12-13)\n', stderr: '' };
      if (args[0] === 'auth' && args[1] === 'status') {
        if (args.includes('--json')) {
          const error = new Error('unknown flag: --json');
          error.stderr = 'unknown flag: --json';
          throw error;
        }
        return { stdout: 'github.com\n  ✓ Logged in to github.com account octocat\n', stderr: '' };
      }
      if (args[0] === 'auth' && args[1] === 'token') return { stdout: `${token}\n`, stderr: '' };
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    });
    return { execFileAsync, calls };
  };

  it('only ever runs version/status/token reads via arg arrays, never auth mutations or git config writes', async () => {
    const fake = createFakeExec();
    const cli = createGhCli({ execFileAsync: fake.execFileAsync, env: { GH_BINARY: '/fake/gh' }, platform: 'linux' });
    await cli.getVersion();
    await cli.getAuthState();
    await cli.getToken('github.com');
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const { binary, args } of fake.calls) {
      expect(binary).toBe('/fake/gh');
      expect(Array.isArray(args)).toBe(true);
      const flat = args.join(' ');
      expect(flat).not.toMatch(/switch|login|logout|setup-git|credential|git-?config/);
    }
    const verbs = fake.calls.map(({ args }) => args.slice(0, 2).join(' '));
    expect(verbs).toContain('--version');
    expect(verbs.some((verb) => verb === 'auth status')).toBe(true);
    expect(verbs.some((verb) => verb === 'auth token')).toBe(true);
  });

  it('maps token failures to gh-unauthenticated without raw output', async () => {
    const fake = createFakeExec();
    fake.execFileAsync.mockImplementationOnce(async () => ({ stdout: 'gh version 2.46.0\n', stderr: '' }));
    fake.execFileAsync.mockImplementation(async (binary, args) => {
      if (args[0] === '--version') return { stdout: 'gh version 2.46.0\n', stderr: '' };
      if (args[0] === 'auth' && args[1] === 'token') {
        const error = new Error('auth failed');
        error.stderr = `host output containing ${SECRET}`;
        throw error;
      }
      return { stdout: '', stderr: '' };
    });
    const cli = createGhCli({ execFileAsync: fake.execFileAsync, env: { GH_BINARY: '/fake/gh' }, platform: 'linux' });
    const failure = await cli.getToken('github.com').catch((error) => error);
    expect(failure).toMatchObject({ kind: 'unavailable', reason: 'gh-unauthenticated' });
    expect(containsSecret(failure.message, [SECRET])).toBe(false);
  });

  it('pins one token per operation so a mid-operation account switch cannot mix credentials', async () => {
    let current = 'gho_account_A_secret_1111';
    const store = createCredentialStore({ ghCli: { getToken: async () => current } });
    const operationToken = await store.withPinnedCredential('github.com', async (cred) => {
      current = 'gho_account_B_secret_2222';
      return cred.token;
    });
    expect(operationToken).toBe('gho_account_A_secret_1111');
    const nextToken = await store.withPinnedCredential('github.com', async (cred) => cred.token);
    expect(nextToken).toBe('gho_account_B_secret_2222');
  });

  it('fingerprints never contain the token', () => {
    const fingerprint = fingerprintToken(HOST, SECRET);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(containsSecret(fingerprint, [SECRET])).toBe(false);
  });
});
