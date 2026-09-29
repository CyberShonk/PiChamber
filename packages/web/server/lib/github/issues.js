/** Issue reads and actions. See DOCUMENTATION.md (§5.2 caching, routes). */

import { createTtlCache, nextCursor, readWithStaleFallback, repoCachePrefix, repoInvalidatePredicate } from './cache.js';
import { inputError, toSectionError } from './errors.js';
import { FULL_ACCEPT, mapIssueComment, mapLabel, mapUser } from './pulls.js';
import {
  FALLBACK_CAPABILITIES,
  buildViewerContextLoader,
  isValidIssueNumber,
  isValidOwnerOrRepo,
  parseEnumParam,
  parsePerPage,
} from './repo-scope.js';

export const LIST_TTL_MS = 30_000;
export const DETAIL_TTL_MS = 15_000;
export const SHORT_TTL_MS = 15_000;
const PER_PAGE = 30;

export const mapIssueSummary = (item) => ({
  number: item.number,
  title: item.title || '',
  url: item.html_url || '',
  state: item.state === 'closed' ? 'closed' : 'open',
  author: mapUser(item.user),
  labels: (item.labels || []).map(mapLabel),
  assignees: (item.assignees || []).map(mapUser),
  comments: typeof item.comments === 'number' ? item.comments : undefined,
  createdAt: item.created_at || null,
  updatedAt: item.updated_at || null,
  closedAt: item.closed_at || null,
});

export const mapIssueDetail = (item) => ({
  ...mapIssueSummary(item),
  body: typeof item.body === 'string' ? item.body : '',
  bodyHtml: typeof item.body_html === 'string' ? item.body_html : null,
  milestone: item.milestone ? { title: item.milestone.title, number: item.milestone.number } : null,
  stateReason: item.state_reason || null,
});

const validateLabels = (labels) => {
  if (labels === undefined) return undefined;
  if (!Array.isArray(labels)) throw inputError('Labels must be an array of names.');
  if (labels.length > 30) throw inputError('Too many labels (max 30).');
  for (const label of labels) {
    if (typeof label !== 'string' || !label.trim() || label.length > 100) {
      throw inputError('Each label must be a non-empty name.');
    }
  }
  return labels.map((label) => label.trim());
};

const validateAssignees = (assignees) => {
  if (assignees === undefined) return undefined;
  if (!Array.isArray(assignees)) throw inputError('Assignees must be an array of logins.');
  if (assignees.length > 10) throw inputError('Too many assignees (max 10).');
  for (const login of assignees) {
    if (typeof login !== 'string' || !login.trim() || login.length > 100) {
      throw inputError('Each assignee must be a GitHub login.');
    }
  }
  return assignees.map((login) => login.trim());
};

const LINKED_PULL_REQUESTS_QUERY = `
query IssueLinkedPullRequests($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 10) {
        nodes {
          number
          title
          state
          isDraft
          url
          repository { nameWithOwner }
        }
      }
      timelineItems(first: 50, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
        nodes {
          __typename
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest {
                number
                title
                state
                isDraft
                url
                repository { nameWithOwner }
              }
            }
          }
          ... on ConnectedEvent {
            subject {
              __typename
              ... on PullRequest {
                number
                title
                state
                isDraft
                url
                repository { nameWithOwner }
              }
            }
          }
        }
      }
    }
  }
}`;

const mapLinkedPullRequestState = (state) => {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'MERGED') return 'merged';
  if (normalized === 'CLOSED') return 'closed';
  return 'open';
};

export const mapLinkedPullRequest = (node, host) => {
  if (!node || typeof node.number !== 'number') return null;
  const nameWithOwner = node.repository?.nameWithOwner;
  const [owner, repo] = typeof nameWithOwner === 'string' ? nameWithOwner.split('/') : [];
  if (!owner || !repo) return null;
  return {
    number: node.number,
    title: typeof node.title === 'string' ? node.title : '',
    state: mapLinkedPullRequestState(node.state),
    draft: node.isDraft === true,
    url: typeof node.url === 'string' ? node.url : '',
    repo: { host, owner, repo },
    repoRef: `${String(host).toLowerCase()}/${owner}/${repo}`,
  };
};

export const createIssuesService = ({ client, now = Date.now, resolveViewer = null, resolvePermission = null } = {}) => {
  if (!client || typeof client.request !== 'function') {
    throw new Error('createIssuesService requires client');
  }
  const listCache = createTtlCache({ ttlMs: LIST_TTL_MS, maxEntries: 300, now });
  const detailCache = createTtlCache({ ttlMs: DETAIL_TTL_MS, maxEntries: 300, now });
  const commentsCache = createTtlCache({ ttlMs: SHORT_TTL_MS, maxEntries: 300, now });
  const metaCache = createTtlCache({ ttlMs: SHORT_TTL_MS, maxEntries: 200, now });

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
    const terms = [`repo:${repo.owner}/${repo.repo}`, 'type:issue'];
    if (state === 'open' || state === 'closed') terms.push(`state:${state}`);
    if (filter === 'mine' && viewerLogin) terms.push(`author:${viewerLogin}`);
    else if (filter === 'assigned' && viewerLogin) terms.push(`assignee:${viewerLogin}`);
    else if (filter === 'mentioned' && viewerLogin) terms.push(`mentions:${viewerLogin}`);
    if (q) terms.push(q);
    return terms.join(' ');
  };

  const listIssues = async (credential, repo, { state = 'open', filter = 'all', q = '', labels = '', cursor = null, sort = 'updated', perPage = PER_PAGE } = {}) => {
    const page = cursor ? Number.parseInt(String(cursor), 10) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      throw inputError('Invalid pagination cursor.');
    }
    const validState = parseEnumParam(state, ['open', 'closed', 'all'], 'open', { name: 'state' });
    const validFilter = parseEnumParam(filter, ['all', 'mine', 'assigned', 'mentioned'], 'all', { name: 'filter' });
    const validSort = parseEnumParam(sort, ['updated', 'created'], 'updated', { name: 'sort' });
    const effectivePerPage = parsePerPage(perPage);
    if (typeof q === 'string' && q.length > 500) {
      throw inputError('Search query is too long.');
    }
    const labelList = typeof labels === 'string' && labels.trim()
      ? labels.split(',').map((label) => label.trim()).filter(Boolean)
      : [];
    const useSearch = Boolean((typeof q === 'string' && q.trim()) || (validFilter && validFilter !== 'all'));
    const viewerLogin = useSearch && resolveViewer ? await resolveViewer(credential) : null;
    const key = `${repoKey(credential, repo)}:issues:${validState}:${validFilter}:${q}:${labelList.join('|')}:${page}:${validSort}:${effectivePerPage}`;
    const load = async () => {
      if (!useSearch) {
        const response = await client.request({
          credential,
          host: repo.host,
          method: 'GET',
          path: `/repos/${repo.owner}/${repo.repo}/issues`,
          query: {
            state: validState,
            labels: labelList.join(',') || undefined,
            sort: validSort,
            direction: 'desc',
            per_page: effectivePerPage,
            page,
          },
          operation: 'issue list',
        });
        // The issues endpoint also returns pull requests; exclude them.
        // The cursor follows the raw page (like pulls' merged filter), so a
        // page containing PRs still advances instead of stalling.
        const raw = Array.isArray(response.body) ? response.body : [];
        const items = raw
          .filter((item) => !item.pull_request)
          .map(mapIssueSummary);
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
        operation: 'issue search',
      });
      const rawItems = Array.isArray(response.body?.items) ? response.body.items : [];
      const items = (rawItems
        .filter((item) => !item.pull_request)
        .map((item) => ({
          number: item.number,
          title: item.title || '',
          url: item.html_url || '',
          state: item.state === 'closed' ? 'closed' : 'open',
          author: mapUser(item.user),
          labels: (item.labels || []).map(mapLabel),
          assignees: (item.assignees || []).map(mapUser),
          comments: typeof item.comments === 'number' ? item.comments : undefined,
          createdAt: item.created_at || null,
          updatedAt: item.updated_at || null,
          closedAt: item.closed_at || null,
        })));
      return { items, nextCursor: nextCursor(rawItems, page, effectivePerPage) };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(listCache, key, load);
    return { repo: { ...repo }, ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  /**
   * Pull requests linked to an issue via GraphQL: PRs that closed/will
   * close the issue plus cross-referenced / connected PR timeline sources.
   * Never throws — failure surfaces as a section error so the section
   * renders an error, never an authoritative empty list.
   */
  const loadLinkedPullRequests = async (credential, repo, number) => {
    try {
      const response = await client.graphql({
        credential, host: repo.host, query: LINKED_PULL_REQUESTS_QUERY,
        variables: { owner: repo.owner, repo: repo.repo, number: Number(number) },
        operation: 'issue linked pull requests',
      });
      const issue = response.body?.repository?.issue;
      const seen = new Set();
      const linked = [];
      const push = (node) => {
        const mapped = mapLinkedPullRequest(node, repo.host);
        if (!mapped) return;
        const key = `${mapped.repoRef}#${mapped.number}`;
        if (seen.has(key)) return;
        seen.add(key);
        linked.push(mapped);
      };
      for (const node of issue?.closedByPullRequestsReferences?.nodes || []) push(node);
      for (const event of issue?.timelineItems?.nodes || []) {
        if (event?.__typename === 'CrossReferencedEvent' && event.source?.__typename === 'PullRequest') push(event.source);
        else if (event?.__typename === 'ConnectedEvent' && event.subject?.__typename === 'PullRequest') push(event.subject);
      }
      return { linkedPullRequests: linked.slice(0, 20) };
    } catch (error) {
      return { linkedPullRequests: [], sectionError: toSectionError(error) };
    }
  };

  const getIssue = async (credential, repo, number) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid issue number.');
    const key = `${repoKey(credential, repo)}:issue:${number}`;
    const load = async () => {
      const [detailResponse, viewerContext, linked] = await Promise.all([
        client.request({
          credential, host: repo.host, method: 'GET',
          path: `/repos/${repo.owner}/${repo.repo}/issues/${number}`,
          accept: FULL_ACCEPT,
          operation: 'issue detail',
        }),
        loadViewerContext(credential, repo).catch(() => ({
          viewerPermission: { level: null, fallback: true },
          capabilities: { ...FALLBACK_CAPABILITIES },
          viewerLogin: null,
        })),
        loadLinkedPullRequests(credential, repo, number),
      ]);
      return {
        issue: mapIssueDetail(detailResponse.body || {}),
        linkedPullRequests: linked.linkedPullRequests,
        viewerPermission: viewerContext.viewerPermission,
        capabilities: viewerContext.capabilities,
        viewerLogin: viewerContext.viewerLogin,
        ...(linked.sectionError ? { sectionErrors: { linkedPullRequests: linked.sectionError } } : {}),
      };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(detailCache, key, load);
    return { repo: { ...repo }, ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  // Cached ~15 s so concurrent mounts coalesce; posting invalidates this
  // number's entries, so a new comment is visible on the immediate re-read.
  const listComments = async (credential, repo, number, { cursor = null } = {}) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid issue number.');
    const page = cursor ? Number.parseInt(String(cursor), 10) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 100) {
      throw inputError('Invalid pagination cursor.');
    }
    const key = `${repoKey(credential, repo)}:comments:${number}:${page}`;
    const load = async () => {
      const response = await client.request({
        credential, host: repo.host, method: 'GET',
        path: `/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`,
        query: { per_page: 100, page },
        accept: FULL_ACCEPT,
        operation: 'issue comments',
      });
      const comments = (Array.isArray(response.body) ? response.body : []).map(mapIssueComment);
      return { comments, nextCursor: nextCursor(comments, page, 100) };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(commentsCache, key, load);
    return { repo: { ...repo }, number: Number(number), ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  const createIssue = async (credential, repo, { title, body = '', labels, assignees, milestone = null }) => {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 300) {
      throw inputError('An issue title is required (max 300 characters).');
    }
    if (typeof body !== 'string' || body.length > 200_000) {
      throw inputError('Issue body is too long.');
    }
    const payload = { title: title.trim(), body };
    const validatedLabels = validateLabels(labels);
    if (validatedLabels !== undefined) payload.labels = validatedLabels;
    const validatedAssignees = validateAssignees(assignees);
    if (validatedAssignees !== undefined) payload.assignees = validatedAssignees;
    if (milestone !== null && milestone !== undefined) {
      const milestoneNumber = Number(milestone);
      if (!Number.isInteger(milestoneNumber) || milestoneNumber < 1) throw inputError('Milestone must be a positive integer.');
      payload.milestone = milestoneNumber;
    }
    const response = await client.request({
      credential, host: repo.host, method: 'POST',
      path: `/repos/${repo.owner}/${repo.repo}/issues`,
      body: payload,
      operation: 'create issue',
    });
    invalidate(credential, repo);
    return { repo: { ...repo }, issue: mapIssueDetail(response.body || {}), fetchedAt: now() };
  };

  const updateIssue = async (credential, repo, number, { title, body, state, stateReason, labels, assignees, milestone }) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid issue number.');
    const payload = {};
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 300) {
        throw inputError('An issue title is required (max 300 characters).');
      }
      payload.title = title.trim();
    }
    if (body !== undefined) {
      if (typeof body !== 'string' || body.length > 200_000) throw inputError('Issue body is too long.');
      payload.body = body;
    }
    if (state !== undefined) {
      if (!['open', 'closed'].includes(state)) throw inputError('Issue state must be open or closed.');
      payload.state = state;
      if (state === 'closed' && stateReason !== undefined) {
        if (!['completed', 'not_planned'].includes(stateReason)) {
          throw inputError('Close reason must be completed or not_planned.');
        }
        payload.state_reason = stateReason;
      }
    }
    const validatedLabels = validateLabels(labels);
    if (validatedLabels !== undefined) payload.labels = validatedLabels;
    const validatedAssignees = validateAssignees(assignees);
    if (validatedAssignees !== undefined) payload.assignees = validatedAssignees;
    if (milestone !== undefined) {
      if (milestone !== null) {
        const milestoneNumber = Number(milestone);
        if (!Number.isInteger(milestoneNumber) || milestoneNumber < 1) throw inputError('Milestone must be a positive integer.');
        payload.milestone = milestoneNumber;
      } else {
        payload.milestone = null;
      }
    }
    if (Object.keys(payload).length === 0) throw inputError('Nothing to update.');
    await client.request({
      credential, host: repo.host, method: 'PATCH',
      path: `/repos/${repo.owner}/${repo.repo}/issues/${number}`,
      body: payload,
      operation: 'update issue',
    });
    // Lightweight result (`issue: null`): the UI ignores the returned detail
    // and re-reads collections + detail after invalidating.
    invalidate(credential, repo, Number(number));
    return { ok: true, issue: null, fetchedAt: now() };
  };

  const postComment = async (credential, repo, number, { body }) => {
    if (!isValidIssueNumber(number)) throw inputError('Invalid issue number.');
    if (typeof body !== 'string' || !body.trim() || body.length > 200_000) {
      throw inputError('A comment body is required (max 200,000 characters).');
    }
    const response = await client.request({
      credential, host: repo.host, method: 'POST',
      path: `/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`,
      body: { body },
      accept: FULL_ACCEPT,
      operation: 'comment on issue',
    });
    invalidate(credential, repo, Number(number));
    return { ok: true, comment: mapIssueComment(response.body || {}), fetchedAt: now() };
  };

  // Labels + assignees load concurrently; cached ~15 s so the compose
  // surfaces mounting together coalesce. Label/assignee mutations go
  // through updateIssue, which invalidates this repo's entries.
  const listMeta = async (credential, repo, { kinds = ['labels', 'assignees'] } = {}) => {
    const requested = new Set(Array.isArray(kinds) ? kinds : [kinds]);
    const key = `${repoKey(credential, repo)}:meta:${[...requested].sort().join('+')}`;
    const load = async () => {
      const [labelsResponse, assigneesResponse] = await Promise.all([
        requested.has('labels')
          ? client.request({
            credential, host: repo.host, method: 'GET',
            path: `/repos/${repo.owner}/${repo.repo}/labels`,
            query: { per_page: 100 },
            operation: 'repository labels',
          })
          : null,
        requested.has('assignees')
          ? client.request({
            credential, host: repo.host, method: 'GET',
            path: `/repos/${repo.owner}/${repo.repo}/assignees`,
            query: { per_page: 100 },
            operation: 'repository assignees',
          })
          : null,
      ]);
      const result = {};
      if (labelsResponse) {
        result.labels = (Array.isArray(labelsResponse.body) ? labelsResponse.body : []).map((label) => ({
          name: label.name, color: label.color || null, description: label.description || null,
        }));
      }
      if (assigneesResponse) {
        result.assignees = (Array.isArray(assigneesResponse.body) ? assigneesResponse.body : [])
          .filter((user) => isValidOwnerOrRepo(user?.login))
          .map(mapUser);
      }
      return result;
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(metaCache, key, load);
    return { repo: { ...repo }, ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  const invalidate = (credential = null, repo = null, number = null) => {
    const fingerprint = credential?.fingerprint || '';
    // List keys end with `:perPage`, so a number filter would never match;
    // invalidate the repo's lists wholesale while scoping detail/comments.
    listCache.invalidate(repoInvalidatePredicate({ fingerprint, repo }));
    detailCache.invalidate(repoInvalidatePredicate({ fingerprint, repo, number }));
    commentsCache.invalidate(repoInvalidatePredicate({ fingerprint, repo, number, matchNumberInside: true }));
    metaCache.invalidate(repoInvalidatePredicate({ fingerprint, repo }));
  };

  return {
    listIssues,
    getIssue,
    listComments,
    createIssue,
    updateIssue,
    postComment,
    listMeta,
    invalidate,
    mapIssueSummary,
    mapIssueDetail,
  };
};
