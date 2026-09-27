import { describe, expect, it, vi } from 'vitest';

import { GitHubAPIError } from '@pichamber/ui/lib/api/types';

vi.mock('@pichamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: vi.fn(),
}));

const { runtimeFetch } = await import('@pichamber/ui/lib/runtime-fetch');
const { createWebGitHubAPI } = await import('./github');

const mockRuntimeFetch = vi.mocked(runtimeFetch);

const jsonResponse = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
}) as unknown as Response;

describe('createWebGitHubAPI', () => {
  it('calls status and scope with runtime URLs', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(jsonResponse({ installed: true, hosts: [] }));
    const api = createWebGitHubAPI();
    await api.status();
    expect(mockRuntimeFetch).toHaveBeenCalledWith('/api/github/status', undefined);

    mockRuntimeFetch.mockResolvedValueOnce(jsonResponse({ repositories: [] }));
    await api.scope('/repo');
    expect(mockRuntimeFetch).toHaveBeenLastCalledWith('/api/github/scope', { query: { directory: '/repo' } });
  });

  it('throws GitHubAPIError with the taxonomy body on failures', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      jsonResponse({ error: { kind: 'unavailable', reason: 'gh-unauthenticated' } }, 503),
    );
    const api = createWebGitHubAPI();
    const error = await api.pullsList('/repo', 'github.com/o/r').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GitHubAPIError);
    expect((error as GitHubAPIError).body).toEqual({ kind: 'unavailable', reason: 'gh-unauthenticated' });
    expect((error as GitHubAPIError).status).toBe(503);
  });

  it('passes list filters and mutation payloads through', async () => {
    const api = createWebGitHubAPI();
    mockRuntimeFetch.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    await api.pullsList('/repo', 'github.com/o/r', { state: 'open', filter: 'mine', q: 'label:bug', cursor: '2' });
    expect(mockRuntimeFetch).toHaveBeenLastCalledWith('/api/github/pulls', {
      query: { directory: '/repo', repo: 'github.com/o/r', state: 'open', filter: 'mine', q: 'label:bug', cursor: '2' },
    });

    mockRuntimeFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await api.pullAction('/repo', 'github.com/o/r', 12, 'squash');
    const [, init] = mockRuntimeFetch.mock.calls.at(-1) as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ directory: '/repo', repo: 'github.com/o/r', action: 'squash' });
  });

  it('sends perPage for wide list fetches', async () => {
    const api = createWebGitHubAPI();
    mockRuntimeFetch.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    await api.pullsList('/repo', 'github.com/o/r', { state: 'all', perPage: 100 });
    expect(mockRuntimeFetch).toHaveBeenLastCalledWith('/api/github/pulls', {
      query: { directory: '/repo', repo: 'github.com/o/r', state: 'all', perPage: '100' },
    });

    mockRuntimeFetch.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    await api.issuesList('/repo', 'github.com/o/r', { state: 'all', perPage: 100 });
    expect(mockRuntimeFetch).toHaveBeenLastCalledWith('/api/github/issues', {
      query: { directory: '/repo', repo: 'github.com/o/r', state: 'all', perPage: '100' },
    });
  });
});
