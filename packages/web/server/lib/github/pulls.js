/** Pull request reads and actions. See DOCUMENTATION.md (§5.2 caching, routes). */

import { createTtlCache, nextCursor, readWithStaleFallback, repoCachePrefix, repoInvalidatePredicate } from './cache.js';
import { failed, inputError, toSectionError } from './errors.js';
import {
  FALLBACK_CAPABILITIES,
  buildViewerContextLoader,
  isValidIssueNumber,
  parseEnumParam,
  parsePerPage,
} from './repo-scope.js';

/** Full media type: responses include `body_html` (server-sanitized,
 * signed image URLs) alongside `body`. Detail/comment reads use this;
 * list summaries stay body-free. Signed image URLs expire (~5 min), far
 * above the 15 s detail TTL and uncached comment reads (see DOCUMENTATION.md). */
export const FULL_ACCEPT = 'application/vnd.github.full+json';

export const LIST_TTL_MS = 30_000;
export const DETAIL_TTL_MS = 15_000;
export const SHORT_TTL_MS = 15_000;
const PER_PAGE = 30;

export const mapUser = (user) => (user && typeof user === 'object' ? {
  login: user.login || null,
  id: typeof user.id === 'number' ? user.id : undefined,
  avatarUrl: user.avatar_url || null,
} : null);

export const mapLabel = (label) => (typeof label === 'string' ? { name: label } : { name: label.name, color: label.color });

const mapPullState = (item) => {
  if (item?.merged_at) return 'merged';
  return item?.state === 'closed' ? 'closed' : 'open';
};

export const mapPullSummary = (item) => ({
  number: item.number,
  title: item.title || '',
  url: item.html_url || '',
  state: mapPullState(item),
  draft: item.draft === true,
  base: item.base?.ref || '',
  head: item.head?.ref || '',
  headSha: item.head?.sha || null,
  author: mapUser(item.user),
  labels: (item.labels || []).map(mapLabel),
  assignees: (item.assignees || []).map(mapUser),
  requestedReviewers: (item.requested_reviewers || []).map(mapUser),
  createdAt: item.created_at || null,
  updatedAt: item.updated_at || null,
  mergedAt: item.merged_at || null,
  additions: typeof item.additions === 'number' ? item.additions : undefined,
  deletions: typeof item.deletions === 'number' ? item.deletions : undefined,
  changedFiles: typeof item.changed_files === 'number' ? item.changed_files : undefined,
  comments: typeof item.comments === 'number' ? item.comments : undefined,
});

const mapReview = (item) => ({
  id: item.id,
  state: item.state || null,
  body: typeof item.body === 'string' ? item.body : '',
  bodyHtml: typeof item.body_html === 'string' ? item.body_html : null,
  author: mapUser(item.user),
  submittedAt: item.submitted_at || null,
  commitId: item.commit_id || null,
});

export const summarizeReviews = (reviews) => {
  let approvals = 0;
  let changesRequested = 0;
  let commented = 0;
  const byUser = new Map();
  for (const review of reviews) {
    if (!review?.author?.login || review.state === 'PENDING') continue;
    byUser.set(review.author.login, review.state);
  }
  for (const state of byUser.values()) {
    if (state === 'APPROVED') approvals += 1;
    else if (state === 'CHANGES_REQUESTED') changesRequested += 1;
    else if (state === 'COMMENTED') commented += 1;
  }
  return {
    approvals,
    changesRequested,
    commented,
    decision: changesRequested > 0 ? 'changes-requested' : (approvals > 0 ? 'approved' : 'pending'),
  };
};

const REVIEW_THREADS_QUERY = `
query PullRequestThreads($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          path
          line
          originalLine
          diffSide
          comments(first: 20) {
            nodes {
              id
              databaseId
              body
              bodyHTML
              createdAt
              updatedAt
              url
              path
              line
              originalLine
              author { login avatarUrl }
            }
          }
        }
      }
    }
  }
}`;

export const mapThread = (node) => ({
  id: node.id,
  resolved: node.isResolved === true,
  path: node.path || null,
  line: node.line ?? null,
  originalLine: node.originalLine ?? null,
  diffSide: node.diffSide || null,
  comments: (node.comments?.nodes || []).map((comment) => ({
    id: comment.databaseId ?? null,
    nodeId: comment.id,
    body: comment.body || '',
    bodyHtml: typeof comment.bodyHTML === 'string' ? comment.bodyHTML : null,
    author: comment.author ? { login: comment.author.login || null, avatarUrl: comment.author.avatarUrl || null } : null,
    createdAt: comment.createdAt || null,
    updatedAt: comment.updatedAt || null,
    url: comment.url || '',
    path: comment.path || null,
    line: comment.line ?? null,
  })),
});

export const createPullsService = ({
  client,
  now = Date.now,
  resolveViewer = null,
  resolvePermission = null,
} = {}) => {
  if (!client || typeof client.request !== 'function') {
    throw new Error('createPullsService requires client');
  }
  const listCache = createTtlCache({ ttlMs: LIST_TTL_MS, maxEntries: 300, now });
  const detailCache = createTtlCache({ ttlMs: DETAIL_TTL_MS, maxEntries: 300, now });
  const filesCache = createTtlCache({ ttlMs: SHORT_TTL_MS, maxEntries: 300, now });
  const commentsCache = createTtlCache({ ttlMs: SHORT_TTL_MS, maxEntries: 300, now });

  const repoKey = (credential, repo) => repoCachePrefix(credential, repo);

  const loadViewerContext = buildViewerContextLoader({
    getPermissions: (cred, ref) => client.request({
      credential: cred, host: ref.host, method: 'GET',
      path: `/repos/${ref.owner}/${ref.repo}`,
      operation: 'repository lookup',
    }).then((response) => ({ permissions: response.body?.permissions ?? null })),
    resolveViewer,
    resolvePermission,
  });

  const buildSearchQuery = ({ repo, state, filter, q, viewerLogin }) => {
    const terms = [`repo:${repo.owner}/${repo.repo}`, 'type:pr'];
    if (state === 'open' || state === 'closed' || state === 'merged') {
      terms.push(state === 'merged' ? 'is:merged' : `state:${state}`);
    }
    if (filter === 'mine' && viewerLogin) terms.push(`author:${viewerLogin}`);
    else if (filter === 'review' && viewerLogin) terms.push(`review-requested:${viewerLogin}`);
    else if (filter === 'assigned' && viewerLogin) terms.push(`assignee:${viewerLogin}`);
    if (q) terms.push(q);
    return terms.join(' ');
  };

  const listPulls = async (credential, repo, { state = 'open', filter = 'all', q = '', cursor = null, sort = 'updated', perPage = PER_PAGE } = {}) => {
    const page = cursor ? Number.parseInt(String(cursor), 10) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      throw inputError('Invalid pagination cursor.');
    }
    const validState = parseEnumParam(state, ['open', 'closed', 'merged', 'all'], 'open', { name: 'state' });
    const validFilter = parseEnumParam(filter, ['all', 'mine', 'review', 'assigned'], 'all', { name: 'filter' });
    const validSort = parseEnumParam(sort, ['updated', 'created'], 'updated', { name: 'sort' });
    const effectivePerPage = parsePerPage(perPage);
    if (typeof q === 'string' && q.length > 500) {
      throw inputError('Search query is too long.');
    }
    const useSearch = Boolean((typeof q === 'string' && q.trim()) || (validFilter && validFilter !== 'all'));
    const viewerLogin = useSearch && resolveViewer ? await resolveViewer(credential) : null;
    const key = `${repoKey(credential, repo)}:pulls:${validState}:${validFilter}:${q}:${page}:${validSort}:${effectivePerPage}:${useSearch ? 'search' : 'list'}`;
    const load = async () => {
      if (!useSearch) {
        const restState = validState === 'merged' ? 'closed' : validState;
        const response = await client.request({
          credential,
          host: repo.host,
          method: 'GET',
          path: `/repos/${repo.owner}/${repo.repo}/pulls`,
          query: {
            state: restState,
            sort: validSort,
            direction: 'desc',
            per_page: effectivePerPage,
            page,
          },
          operation: 'pull request list',
        });
        const raw = Array.isArray(response.body) ? response.body : [];
        let items = raw.map(mapPullSummary);
        if (validState === 'merged') items = items.filter((item) => item.state === 'merged');
        // Cursor follows the raw page: a filtered-out page still advances.
        return { items, nextCursor: nextCursor(raw, page, effectivePerPage) };
      }
      const response = await client.request({
        credential,
        host: repo.host,
        method: 'GET',
        path: '/search/issues',
        query: {
          q: buildSearchQuery({ repo, state: validState, filter: validFilter, q: (q || '').trim(), viewerLogin }),
          sort: validSort,
          order: 'desc',
          per_page: effectivePerPage,
          page,
        },
        operation: 'pull request search',
      });
      const items = ((response.body?.items || []).map((item) => ({
        number: item.number,
        title: item.title || '',
        url: item.html_url || '',
        state: item.pull_request?.merged_at ? 'merged' : (item.state === 'closed' ? 'closed' : 'open'),
        draft: item.draft === true,
        base: '',
        head: '',
        headSha: null,
        author: mapUser(item.user),
        labels: (item.labels || []).map(mapLabel),
        assignees: (item.assignees || []).map(mapUser),
        requestedReviewers: [],
        createdAt: item.created_at || null,
        updatedAt: item.updated_at || null,
        mergedAt: item.pull_request?.merged_at || item.merged_at || null,
      })));
      return { items, nextCursor: nextCursor(items, page, effectivePerPage) };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(listCache, key, load);
    return { repo: { ...repo }, ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  const getPull = async (credential, repo, number) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    const key = `${repoKey(credential, repo)}:pull:${number}`;
    const load = async () => {
      // Nothing below depends on the detail body, so every read runs in
      // parallel; only a detail failure fails the whole load.
      const [detailResponse, reviewsSettled, threadsSettled, viewerContext] = await Promise.all([
        client.request({
          credential, host: repo.host, method: 'GET',
          path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
          accept: FULL_ACCEPT,
          operation: 'pull request detail',
        }),
        client.request({
          credential, host: repo.host, method: 'GET',
          path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews`,
          query: { per_page: 100 },
          accept: FULL_ACCEPT,
          operation: 'pull request reviews',
        }).then((response) => ({ ok: true, response }), (error) => ({ ok: false, error })),
        client.graphql({
          credential, host: repo.host, query: REVIEW_THREADS_QUERY,
          variables: { owner: repo.owner, repo: repo.repo, number: Number(number) },
          operation: 'review threads',
        }).then((response) => ({ ok: true, response }), (error) => ({ ok: false, error })),
        loadViewerContext(credential, repo).catch(() => ({
          viewerPermission: { level: null, fallback: true },
          capabilities: { ...FALLBACK_CAPABILITIES },
          viewerLogin: null,
        })),
      ]);
      const item = detailResponse.body || {};
      const sectionErrors = {};
      let reviews = [];
      if (reviewsSettled.ok) {
        reviews = (Array.isArray(reviewsSettled.response.body) ? reviewsSettled.response.body : []).map(mapReview);
      } else {
        sectionErrors.reviews = toSectionError(reviewsSettled.error);
      }
      let threads = [];
      let nodeId = null;
      if (threadsSettled.ok) {
        threads = threadsSettled.response.body?.repository?.pullRequest?.reviewThreads?.nodes || [];
        nodeId = threadsSettled.response.body?.repository?.pullRequest?.id || null;
      } else {
        sectionErrors.threads = toSectionError(threadsSettled.error);
      }
      return {
        pr: {
          ...mapPullSummary(item),
          body: typeof item.body === 'string' ? item.body : '',
          bodyHtml: typeof item.body_html === 'string' ? item.body_html : null,
          mergeable: item.mergeable ?? null,
          mergeableState: item.mergeable_state || null,
          labels: (item.labels || []).map(mapLabel),
          assignees: (item.assignees || []).map(mapUser),
          requestedReviewers: (item.requested_reviewers || []).map(mapUser),
          milestone: item.milestone ? { title: item.milestone.title, number: item.milestone.number } : null,
          reviewSummary: summarizeReviews(reviews),
        },
        reviews,
        threads: threads.map(mapThread),
        nodeId,
        viewerPermission: viewerContext.viewerPermission,
        capabilities: viewerContext.capabilities,
        viewerLogin: viewerContext.viewerLogin,
        ...(Object.keys(sectionErrors).length > 0 ? { sectionErrors } : {}),
      };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(detailCache, key, load);
    return { repo: { ...repo }, ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  const listFiles = async (credential, repo, number, { cursor = null } = {}) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    const page = cursor ? Number.parseInt(String(cursor), 10) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      throw inputError('Invalid pagination cursor.');
    }
    const key = `${repoKey(credential, repo)}:files:${number}:${page}`;
    const load = async () => {
      const response = await client.request({
        credential,
        host: repo.host,
        method: 'GET',
        path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}/files`,
        query: { per_page: 100, page },
        operation: 'pull request files',
      });
      const files = (Array.isArray(response.body) ? response.body : []).map((file) => ({
        filename: file.filename,
        status: file.status || null,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        changes: file.changes ?? 0,
        patch: typeof file.patch === 'string' ? file.patch : null,
      }));
      return { files, nextCursor: nextCursor(files, page, 100) };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(filesCache, key, load);
    return { repo: { ...repo }, number: Number(number), ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  /**
   * Cheapest correct head SHA for checks: one single-resource REST read.
   * The checks route used to re-run the full detail fan-out (detail +
   * reviews + threads + viewer) just for this SHA.
   */
  const getPullHeadSha = async (credential, repo, number) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    const response = await client.request({
      credential,
      host: repo.host,
      method: 'GET',
      path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
      operation: 'pull request head',
    });
    const sha = response.body?.head?.sha;
    if (typeof sha !== 'string' || !sha) {
      throw failed('Pull request has no head commit to check.');
    }
    return sha;
  };

  const invalidate = (credential = null, repo = null, number = null) => {
    const fingerprint = credential?.fingerprint || '';
    listCache.invalidate(repoInvalidatePredicate({ fingerprint, repo }));
    detailCache.invalidate(repoInvalidatePredicate({ fingerprint, repo, number, matchNumberInside: true }));
    filesCache.invalidate(repoInvalidatePredicate({ fingerprint, repo, number, matchNumberInside: true }));
    commentsCache.invalidate(repoInvalidatePredicate({ fingerprint, repo, number, matchNumberInside: true }));
  };

  const createPull = async (credential, repo, { title, head, base, body = '', draft = false }) => {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 300) {
      throw inputError('A pull request title is required (max 300 characters).');
    }
    if (typeof head !== 'string' || !head.trim() || head.length > 300) {
      throw inputError('A head branch is required.');
    }
    if (typeof base !== 'string' || !base.trim() || base.length > 300) {
      throw inputError('A base branch is required.');
    }
    const response = await client.request({
      credential,
      host: repo.host,
      method: 'POST',
      path: `/repos/${repo.owner}/${repo.repo}/pulls`,
      body: { title: title.trim(), head: head.trim(), base: base.trim(), body: String(body || ''), draft: draft === true },
      operation: 'create pull request',
    });
    invalidate(credential, repo);
    return { repo: { ...repo }, pr: mapPullSummary(response.body || {}), fetchedAt: now() };
  };

  const MERGE_METHODS = { merge: 'merge', squash: 'squash', rebase: 'rebase' };

  // Mutation results stay lightweight (`pr: null`): the UI ignores the
  // returned detail and re-reads collections + detail after invalidating,
  // so re-running the detail fan-out here only costs a duplicate fetch.
  // Caches are still invalidated so the re-read observes the mutation.
  const runAction = async (credential, repo, number, action, options = {}) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    const num = Number(number);
    if (action === 'merge' || action === 'squash' || action === 'rebase') {
      const response = await client.request({
        credential, host: repo.host, method: 'POST',
        path: `/repos/${repo.owner}/${repo.repo}/pulls/${num}/merge`,
        body: { merge_method: MERGE_METHODS[action] },
        operation: `${action} pull request`,
      });
      invalidate(credential, repo, num);
      return { ok: response.body?.merged === true, action, message: response.body?.message || null, pr: null, fetchedAt: now() };
    }
    if (action === 'ready') {
      await client.request({
        credential, host: repo.host, method: 'POST',
        path: `/repos/${repo.owner}/${repo.repo}/pulls/${num}/ready_for_review`,
        operation: 'mark pull request ready',
      });
      invalidate(credential, repo, num);
      return { ok: true, action, pr: null, fetchedAt: now() };
    }
    if (action === 'draft') {
      const detail = await getPull(credential, repo, num);
      if (!detail.nodeId) throw inputError('Could not resolve the pull request for draft conversion.');
      await client.graphql({
        credential, host: repo.host,
        query: 'mutation ConvertToDraft($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }',
        variables: { id: detail.nodeId },
        operation: 'convert pull request to draft',
      });
      invalidate(credential, repo, num);
      return { ok: true, action, pr: null, fetchedAt: now() };
    }
    if (action === 'close' || action === 'reopen') {
      await client.request({
        credential, host: repo.host, method: 'PATCH',
        path: `/repos/${repo.owner}/${repo.repo}/pulls/${num}`,
        body: { state: action === 'close' ? 'closed' : 'open' },
        operation: `${action} pull request`,
      });
      invalidate(credential, repo, num);
      return { ok: true, action, pr: null, fetchedAt: now() };
    }
    if (action === 'update-branch') {
      const response = await client.request({
        credential, host: repo.host, method: 'PUT',
        path: `/repos/${repo.owner}/${repo.repo}/pulls/${num}/update-branch`,
        body: options.expectedHeadSha ? { expected_head_sha: options.expectedHeadSha } : {},
        operation: 'update pull request branch',
      });
      invalidate(credential, repo, num);
      return { ok: true, action, message: response.body?.message || null, pr: null, fetchedAt: now() };
    }
    throw inputError(`Unknown pull request action: ${action}.`);
  };

  const updatePull = async (credential, repo, number, { title, body }) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    const patch = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 300) {
        throw inputError('A pull request title is required (max 300 characters).');
      }
      patch.title = title.trim();
    }
    if (body !== undefined) {
      if (typeof body !== 'string' || body.length > 200_000) throw inputError('Pull request body is too long.');
      patch.body = body;
    }
    if (Object.keys(patch).length === 0) throw inputError('Nothing to update.');
    await client.request({
      credential, host: repo.host, method: 'PATCH',
      path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
      body: patch,
      operation: 'update pull request',
    });
    invalidate(credential, repo, Number(number));
    return { ok: true, pr: null, fetchedAt: now() };
  };

  const postComment = async (credential, repo, number, { body }) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    if (typeof body !== 'string' || !body.trim() || body.length > 200_000) {
      throw inputError('A comment body is required (max 200,000 characters).');
    }
    const response = await client.request({
      credential, host: repo.host, method: 'POST',
      path: `/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`,
      body: { body },
      accept: FULL_ACCEPT,
      operation: 'comment on pull request',
    });
    invalidate(credential, repo, Number(number));
    return { ok: true, comment: mapIssueComment(response.body || {}), fetchedAt: now() };
  };

  /**
   * Top-level (conversation) comments on a PR through the issues comments
   * API for the PR number — paginated, oldest-first pages of 100. Cached
   * ~15 s so concurrent mounts coalesce; posting invalidates this number's
   * entries, so a new comment is visible on the immediate re-read.
   */
  const listPullComments = async (credential, repo, number, { cursor = null } = {}) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    const page = cursor ? Number.parseInt(String(cursor), 10) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      throw inputError('Invalid pagination cursor.');
    }
    const key = `${repoKey(credential, repo)}:pull-comments:${number}:${page}`;
    const load = async () => {
      const response = await client.request({
        credential, host: repo.host, method: 'GET',
        path: `/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`,
        query: { per_page: 100, page },
        accept: FULL_ACCEPT,
        operation: 'pull request comments',
      });
      const comments = (Array.isArray(response.body) ? response.body : []).map(mapIssueComment);
      return { comments, nextCursor: nextCursor(comments, page, 100) };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(commentsCache, key, load);
    return { repo: { ...repo }, number: Number(number), ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  const submitReview = async (credential, repo, number, { event, body = '', comments = [], commitId = null }) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    const normalizedEvent = String(event || 'comment').toUpperCase();
    if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(normalizedEvent)) {
      throw inputError('Review event must be approve, request-changes, or comment.');
    }
    if (!Array.isArray(comments)) throw inputError('Review comments must be an array.');
    if (comments.length > 50) throw inputError('Too many inline comments in one review (max 50).');
    const mapped = comments.map((comment) => {
      if (typeof comment?.body !== 'string' || !comment.body.trim()) throw inputError('Each inline comment needs a body.');
      if (typeof comment?.path !== 'string' || !comment.path) throw inputError('Each inline comment needs a path.');
      const entry = { path: comment.path, body: comment.body };
      if (comment.line != null) {
        const line = Number(comment.line);
        if (!Number.isInteger(line) || line < 1) throw inputError('Inline comment line must be a positive integer.');
        entry.line = line;
      } else if (comment.position != null) {
        const position = Number(comment.position);
        if (!Number.isInteger(position) || position < 1) throw inputError('Inline comment position must be a positive integer.');
        entry.position = position;
      } else {
        throw inputError('Each inline comment needs a line or position.');
      }
      if (comment.side) {
        if (!['LEFT', 'RIGHT'].includes(String(comment.side).toUpperCase())) throw inputError('Inline comment side must be LEFT or RIGHT.');
        entry.side = String(comment.side).toUpperCase();
      }
      if (comment.startLine != null) {
        const startLine = Number(comment.startLine);
        if (!Number.isInteger(startLine) || startLine < 1) throw inputError('Inline comment start line must be a positive integer.');
        entry.start_line = startLine;
        entry.start_side = comment.startSide ? String(comment.startSide).toUpperCase() : entry.side;
      }
      return entry;
    });
    const payload = { body: String(body || ''), event: normalizedEvent };
    if (commitId) payload.commit_id = commitId;
    if (mapped.length > 0) payload.comments = mapped;
    const response = await client.request({
      credential, host: repo.host, method: 'POST',
      path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews`,
      body: payload,
      operation: 'submit pull request review',
    });
    invalidate(credential, repo, Number(number));
    return { ok: true, review: mapReview(response.body || {}), fetchedAt: now() };
  };

  const replyToThread = async (credential, repo, number, commentId, { body }) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    if (!isValidIssueNumber(commentId)) throw inputError('Invalid comment id.');
    if (typeof body !== 'string' || !body.trim() || body.length > 200_000) {
      throw inputError('A reply body is required (max 200,000 characters).');
    }
    const response = await client.request({
      credential, host: repo.host, method: 'POST',
      path: `/repos/${repo.owner}/${repo.repo}/pulls/${number}/comments/${commentId}/replies`,
      body: { body },
      operation: 'reply to review thread',
    });
    invalidate(credential, repo, Number(number));
    return { ok: true, comment: mapReviewComment(response.body || {}), fetchedAt: now() };
  };

  const setThreadResolved = async (credential, repo, number, threadId, resolved) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid pull request number.');
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) {
      throw inputError('A thread id is required (max 200 characters).');
    }
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await client.graphql({
      credential, host: repo.host,
      query: `mutation SetThreadResolved($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { id isResolved } } }`,
      variables: { id: threadId },
      operation: resolved ? 'resolve review thread' : 'unresolve review thread',
    });
    invalidate(credential, repo, Number(number));
    return { ok: true, threadId, resolved, fetchedAt: now() };
  };

  const findPullForBranch = async (credential, repo, { branch, headOwner = null, defaultBranch = null }) => {
    if (typeof branch !== 'string' || !branch.trim()) throw inputError('A branch name is required.');
    const cleanBranch = branch.trim();
    if (cleanBranch.length > 300) throw inputError('Branch name is too long.');
    if (defaultBranch && cleanBranch === defaultBranch) {
      return { repo: { ...repo }, branch: cleanBranch, pr: null, skippedDefaultBranch: true, fetchedAt: now() };
    }
    const owner = headOwner || repo.owner;
    const openResponse = await client.request({
      credential, host: repo.host, method: 'GET',
      path: `/repos/${repo.owner}/${repo.repo}/pulls`,
      query: { head: `${owner}:${cleanBranch}`, state: 'open', per_page: 5 },
      operation: 'find pull request for branch',
    });
    const openItems = Array.isArray(openResponse.body) ? openResponse.body : [];
    if (openItems.length > 0) {
      const summary = mapPullSummary(openItems[0]);
      return { repo: { ...repo }, branch: cleanBranch, pr: summary, fetchedAt: now() };
    }
    const closedResponse = await client.request({
      credential, host: repo.host, method: 'GET',
      path: `/repos/${repo.owner}/${repo.repo}/pulls`,
      query: { head: `${owner}:${cleanBranch}`, state: 'closed', per_page: 5, sort: 'updated', direction: 'desc' },
      operation: 'find pull request for branch',
    });
    const closedItems = Array.isArray(closedResponse.body) ? closedResponse.body : [];
    return {
      repo: { ...repo },
      branch: cleanBranch,
      pr: closedItems.length > 0 ? mapPullSummary(closedItems[0]) : null,
      fetchedAt: now(),
    };
  };

  return {
    listPulls,
    getPull,
    listPullComments,
    listFiles,
    getPullHeadSha,
    createPull,
    runAction,
    updatePull,
    postComment,
    submitReview,
    replyToThread,
    setThreadResolved,
    findPullForBranch,
    invalidate,
    mapPullSummary,
    summarizeReviews,
  };
};

export const mapIssueComment = (item) => ({
  id: item.id,
  body: typeof item.body === 'string' ? item.body : '',
  bodyHtml: typeof item.body_html === 'string' ? item.body_html : null,
  author: mapUser(item.user),
  createdAt: item.created_at || null,
  updatedAt: item.updated_at || null,
  url: item.html_url || '',
});

export const mapReviewComment = (item) => ({
  id: item.id,
  body: typeof item.body === 'string' ? item.body : '',
  bodyHtml: typeof item.body_html === 'string' ? item.body_html : null,
  author: mapUser(item.user),
  path: item.path || null,
  line: item.line ?? null,
  originalLine: item.original_line ?? null,
  createdAt: item.created_at || null,
  updatedAt: item.updated_at || null,
  url: item.html_url || '',
});
