import type {
  GitHubAPI,
  GitHubCheckRunStep,
  GitHubChecksResult,
  GitHubContextResult,
  GitHubContextType,
  GitHubErrorBody,
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueCommentsResult,
  GitHubIssueGetResult,
  GitHubIssueTemplatesResult,
  GitHubIssuesListResult,
  GitHubIssuesQuery,
  GitHubPullRequestAction,
  GitHubPullRequestActionResult,
  GitHubPullRequestCreateInput,
  GitHubPullRequestDetail,
  GitHubPullRequestDetailResult,
  GitHubPullRequestFilesResult,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitHubPullRequestsListResult,
  GitHubPullsQuery,
  GitHubRepoRef,
  GitHubReview,
  GitHubReviewInlineComment,
  GitHubScope,
  GitHubStatus,
  GitHubUserSummary,
} from '@pichamber/ui/lib/api/types';
import { GitHubAPIError } from '@pichamber/ui/lib/api/types';
import { runtimeFetch, type RuntimeFetchOptions } from '@pichamber/ui/lib/runtime-fetch';

const API_BASE = '/api/github';

const readErrorBody = (body: unknown, status: number): GitHubErrorBody => {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error: GitHubErrorBody }).error;
    if (error && typeof error.kind === 'string') return error;
  }
  return { kind: 'failed', message: `GitHub request failed (HTTP ${status}).` };
};

const requestJson = async <T>(path: string, init?: RuntimeFetchOptions): Promise<T> => {
  const response = await runtimeFetch(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || (body && typeof body === 'object' && 'error' in body)) {
    throw new GitHubAPIError(readErrorBody(body, response.status), response.status);
  }
  return body as T;
};

const withRepoQuery = (directory: string, repo: string, extra?: Record<string, string | undefined>) => ({
  query: { directory, repo, ...extra },
});

export const createWebGitHubAPI = (): GitHubAPI => ({
  status: () => requestJson<GitHubStatus>(`${API_BASE}/status`),

  scope: (directory: string) => requestJson<GitHubScope>(`${API_BASE}/scope`, { query: { directory } }),

  pullsList: (directory: string, repo: string, query: GitHubPullsQuery = {}) =>
    requestJson<GitHubPullRequestsListResult>(`${API_BASE}/pulls`, {
      query: {
        directory,
        repo,
        ...(query.state ? { state: query.state } : {}),
        ...(query.filter ? { filter: query.filter } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.sort ? { sort: query.sort } : {}),
        ...(query.perPage != null ? { perPage: String(query.perPage) } : {}),
      },
    }),

  pullGet: (directory: string, repo: string, number: number) =>
    requestJson<GitHubPullRequestDetailResult>(`${API_BASE}/pulls/${number}`, withRepoQuery(directory, repo)),

  pullFiles: (directory: string, repo: string, number: number, cursor?: string | null) =>
    requestJson<GitHubPullRequestFilesResult>(`${API_BASE}/pulls/${number}/files`, withRepoQuery(directory, repo, cursor ? { cursor } : {})),

  pullChecks: (directory: string, repo: string, number: number, details?: boolean) =>
    requestJson<GitHubChecksResult>(
      `${API_BASE}/pulls/${number}/checks`,
      withRepoQuery(directory, repo, details ? { details: 'full' } : {}),
    ),

  prStatus: (directory: string, branch?: string | null) =>
    requestJson<GitHubPullRequestStatus>(`${API_BASE}/pr-status`, {
      query: branch ? { directory, branch } : { directory },
    }),

  pullCreate: (input: GitHubPullRequestCreateInput) =>
    requestJson<{ repo: GitHubRepoRef; pr: GitHubPullRequestSummary; fetchedAt: number }>(`${API_BASE}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  pullAction: (directory: string, repo: string, number: number, action: GitHubPullRequestAction) =>
    requestJson<GitHubPullRequestActionResult>(`${API_BASE}/pulls/${number}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, action }),
    }),

  pullUpdate: (directory: string, repo: string, number: number, patch: { title?: string; body?: string }) =>
    requestJson<{ ok: boolean; pr: GitHubPullRequestDetail | null; fetchedAt: number }>(`${API_BASE}/pulls/${number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, ...patch }),
    }),

  pullComment: (directory: string, repo: string, number: number, body: string) =>
    requestJson<{ ok: boolean; comment: GitHubIssueComment; fetchedAt: number }>(`${API_BASE}/pulls/${number}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, body }),
    }),

  pullComments: (directory: string, repo: string, number: number, cursor?: string | null) =>
    requestJson<GitHubIssueCommentsResult>(`${API_BASE}/pulls/${number}/comments`, withRepoQuery(directory, repo, cursor ? { cursor } : {})),

  pullReview: (
    directory: string,
    repo: string,
    number: number,
    review: { event: 'approve' | 'request-changes' | 'comment'; body?: string; comments?: GitHubReviewInlineComment[] },
  ) =>
    requestJson<{ ok: boolean; review: GitHubReview; fetchedAt: number }>(`${API_BASE}/pulls/${number}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, ...review }),
    }),

  pullThread: (
    directory: string,
    repo: string,
    number: number,
    threadId: string,
    action: { action: 'reply'; body: string; commentId: number } | { action: 'resolve' | 'unresolve' },
  ) =>
    requestJson<{ ok: boolean; fetchedAt: number }>(`${API_BASE}/pulls/${number}/threads/${encodeURIComponent(threadId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, ...action }),
    }),

  pullCheckout: (directory: string, repo: string, number: number, mode: 'worktree' | 'current' = 'worktree') =>
    requestJson<{ ok: boolean; mode: string; branch: string; headSha: string; path: string | null; fetchedAt: number }>(
      `${API_BASE}/pulls/${number}/checkout`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory, repo, mode }),
      },
    ),

  issuesList: (directory: string, repo: string, query: GitHubIssuesQuery = {}) =>
    requestJson<GitHubIssuesListResult>(`${API_BASE}/issues`, {
      query: {
        directory,
        repo,
        ...(query.state ? { state: query.state } : {}),
        ...(query.filter ? { filter: query.filter } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.labels ? { labels: query.labels } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.sort ? { sort: query.sort } : {}),
        ...(query.perPage != null ? { perPage: String(query.perPage) } : {}),
      },
    }),

  issueGet: (directory: string, repo: string, number: number) =>
    requestJson<GitHubIssueGetResult>(`${API_BASE}/issues/${number}`, withRepoQuery(directory, repo)),

  issueComments: (directory: string, repo: string, number: number, cursor?: string | null) =>
    requestJson<GitHubIssueCommentsResult>(`${API_BASE}/issues/${number}/comments`, withRepoQuery(directory, repo, cursor ? { cursor } : {})),

  issueCreate: (
    directory: string,
    repo: string,
    input: { title: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number | null },
  ) =>
    requestJson<{ repo: GitHubRepoRef; issue: GitHubIssue; fetchedAt: number }>(`${API_BASE}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, ...input }),
    }),

  issueUpdate: (
    directory: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; stateReason?: 'completed' | 'not_planned'; labels?: string[]; assignees?: string[]; milestone?: number | null },
  ) =>
    requestJson<{ ok: boolean; issue: GitHubIssue | null; fetchedAt: number }>(`${API_BASE}/issues/${number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, ...patch }),
    }),

  issueComment: (directory: string, repo: string, number: number, body: string) =>
    requestJson<{ ok: boolean; comment: GitHubIssueComment; fetchedAt: number }>(`${API_BASE}/issues/${number}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, body }),
    }),

  repoMeta: (directory: string, repo: string, kinds?: Array<'labels' | 'assignees'>) =>
    requestJson<{ repo: GitHubRepoRef; labels?: GitHubIssue['labels']; assignees?: GitHubUserSummary[]; fetchedAt: number }>(
      `${API_BASE}/meta`,
      withRepoQuery(directory, repo, kinds?.length ? { kinds: kinds.join(',') } : {}),
    ),

  issueTemplates: (directory: string, repo: string) =>
    requestJson<GitHubIssueTemplatesResult>(`${API_BASE}/templates`, withRepoQuery(directory, repo)),

  checkJobs: (directory: string, repo: string, runId: number | null, jobId?: number | null) =>
    requestJson<{ repo: GitHubRepoRef; runId: number | null; jobs: Array<{ id: number; name: string; status?: string | null; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null; detailsUrl?: string | null; steps: GitHubCheckRunStep[] }>; fetchedAt: number }>(
      `${API_BASE}/checks/jobs`,
      withRepoQuery(directory, repo, { ...(runId != null ? { runId: String(runId) } : {}), ...(jobId != null ? { jobId: String(jobId) } : {}) }),
    ),

  checkAnnotations: (directory: string, repo: string, checkRunId: number) =>
    requestJson<{ repo: GitHubRepoRef; checkRunId: number; annotations: Array<{ path?: string | null; startLine?: number | null; endLine?: number | null; level?: string | null; message: string; title?: string | null }>; fetchedAt: number }>(
      `${API_BASE}/checks/annotations`,
      withRepoQuery(directory, repo, { checkRunId: String(checkRunId) }),
    ),

  checksRerun: (directory: string, repo: string, runId: number) =>
    requestJson<{ ok: boolean; runId: number; fetchedAt: number }>(`${API_BASE}/checks/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, repo, runId }),
    }),

  agentContext: (directory: string, repo: string, type: GitHubContextType, number: number, options?: { ref?: string; includeDiff?: boolean }) =>
    requestJson<GitHubContextResult>(`${API_BASE}/context`, {
      query: {
        directory,
        repo,
        type,
        number: String(number),
        ...(options?.ref ? { ref: options.ref } : {}),
        ...(options?.includeDiff ? { includeDiff: 'true' } : {}),
      },
    }),

  invalidate: (input?: { directory?: string; repo?: string; kind?: 'pulls' | 'issues' | 'checks' | 'repo' | 'all'; number?: number }) =>
    requestJson<{ ok: boolean; fetchedAt: number }>(`${API_BASE}/invalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input ?? {}),
    }),
});
