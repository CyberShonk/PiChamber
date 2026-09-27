import type { GitHubIssueSummary, GitHubPullRequestSummary } from '@/lib/api/types';

/**
 * Shared client-side list filtering/sorting for the Pull requests and Issues
 * surfaces. Lists fetch one wide collection per repo scope (`open` + `closed`,
 * perPage 100) and every view — state tab, involvement, labels, text search,
 * sort — is a pure `useMemo` selector over those collections, so typing and
 * tab switches never hit the network.
 *
 * Involvement needs the viewer login (`useGitHubLogin`). When it is unknown
 * the involvement predicate passes everything through and the surface falls
 * back to the server search path for those views — never an
 * authoritatively-empty local result.
 */

export type ListSort = 'updated' | 'newest' | 'oldest';

export type PullItem = GitHubPullRequestSummary & {
  assignees?: Array<{ login?: string | null } | null> | null;
  requestedReviewers?: Array<{ login?: string | null } | null> | null;
  labels?: Array<{ name: string; color?: string | null } | null> | null;
};

export type IssueItem = GitHubIssueSummary;

/** `#123` or a bare `123` (up to 7 digits) addresses an item by number. */
export const parseNumberQuery = (query: string): number | null => {
  const match = query.trim().match(/^#?(\d{1,7})$/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const eqLogin = (a?: string | null, b?: string | null): boolean => {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
};

const loginsOf = (users?: Array<{ login?: string | null } | null> | null): string[] => {
  if (!users) return [];
  const out: string[] = [];
  for (const user of users) {
    if (user?.login) out.push(user.login.toLowerCase());
  }
  return out;
};

/** Split a raw query into `label:xxx` qualifiers plus plain text tokens. */
const tokenizeSearch = (query: string): { tokens: string[]; labelTokens: string[] } => {
  const tokens: string[] = [];
  const labelTokens: string[] = [];
  for (const raw of query.trim().toLowerCase().split(/\s+/)) {
    if (!raw) continue;
    if (raw.startsWith('label:') && raw.length > 'label:'.length) {
      labelTokens.push(raw.slice('label:'.length));
    } else {
      tokens.push(raw);
    }
  }
  return { tokens, labelTokens };
};

const labelNamesOf = (labels?: Array<{ name: string; color?: string | null } | null> | null): string[] => {
  if (!labels) return [];
  const out: string[] = [];
  for (const label of labels) {
    if (label?.name) out.push(label.name.toLowerCase());
  }
  return out;
};

const matchesLabelFilter = (
  itemLabels: Array<{ name: string; color?: string | null } | null> | null | undefined,
  labelsCsv: string,
  labelTokens: string[],
): boolean => {
  const names = labelNamesOf(itemLabels ?? null);
  const csv = labelsCsv
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  for (const wanted of [...csv, ...labelTokens]) {
    if (!names.some((name) => name === wanted || name.includes(wanted))) return false;
  }
  return true;
};

const pullHaystacks = (item: PullItem): string[] => {
  const haystacks = [
    item.title.toLowerCase(),
    `#${item.number}`,
    `${item.number}`,
    item.author?.login?.toLowerCase() ?? '',
    item.head.toLowerCase(),
    item.base.toLowerCase(),
  ];
  for (const name of labelNamesOf(item.labels)) haystacks.push(name);
  return haystacks;
};

const issueHaystacks = (item: IssueItem): string[] => {
  const haystacks = [
    item.title.toLowerCase(),
    `#${item.number}`,
    `${item.number}`,
    item.author?.login?.toLowerCase() ?? '',
  ];
  for (const name of labelNamesOf(item.labels)) haystacks.push(name);
  return haystacks;
};

/** Every token must match at least one haystack (case-insensitive AND). */
const matchesAllTokens = (haystacks: string[], tokens: string[]): boolean => {
  for (const token of tokens) {
    let hit = false;
    for (const haystack of haystacks) {
      if (haystack.includes(token)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
};

const isMergedPull = (item: PullItem): boolean =>
  item.state === 'merged' || Boolean((item as { mergedAt?: string | null }).mergedAt);

/** Split the `closed` collection (merged + closed) into its local views. */
export const applyPullStateView = <T extends PullItem>(
  items: T[],
  state: 'open' | 'closed' | 'merged' | 'all',
): T[] => {
  if (state === 'all') return items;
  if (state === 'open') return items.filter((item) => item.state === 'open');
  if (state === 'merged') return items.filter((item) => isMergedPull(item));
  return items.filter((item) => item.state === 'closed' && !isMergedPull(item));
};

export const applyIssueStateView = <T extends IssueItem>(
  items: T[],
  state: 'open' | 'closed' | 'all',
): T[] => {
  if (state === 'all') return items;
  return items.filter((item) => item.state === state);
};

export const matchesPullInvolvement = (
  item: PullItem,
  involvement: 'all' | 'mine' | 'review' | 'assigned',
  viewerLogin: string | null,
): boolean => {
  if (involvement === 'all') return true;
  // Unknown viewer: pass through locally; the surface falls back to the
  // server search so the view never claims an authoritative empty result.
  if (!viewerLogin) return true;
  if (involvement === 'mine') return eqLogin(item.author?.login, viewerLogin);
  if (involvement === 'review') return loginsOf(item.requestedReviewers).includes(viewerLogin.toLowerCase());
  return loginsOf(item.assignees).includes(viewerLogin.toLowerCase());
};

export const matchesIssueInvolvement = (
  item: IssueItem,
  involvement: 'all' | 'mine' | 'assigned' | 'mentioned',
  viewerLogin: string | null,
): boolean => {
  if (involvement === 'all') return true;
  // `mentioned` has no local signal — pass through and let the surface use
  // the server search. Same when the viewer login is unknown.
  if (!viewerLogin || involvement === 'mentioned') return true;
  if (involvement === 'mine') return eqLogin(item.author?.login, viewerLogin);
  return loginsOf(item.assignees).includes(viewerLogin.toLowerCase());
};

export type PullFilterOptions = {
  state: 'open' | 'closed' | 'merged' | 'all';
  involvement: 'all' | 'mine' | 'review' | 'assigned';
  search: string;
  sort: ListSort;
  viewerLogin: string | null;
};

export type IssueFilterOptions = {
  state: 'open' | 'closed' | 'all';
  involvement: 'all' | 'mine' | 'assigned' | 'mentioned';
  labels: string;
  search: string;
  sort: ListSort;
  viewerLogin: string | null;
};

const timestampOf = (value: string | null | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const sortListItems = <T extends { number: number; createdAt?: string | null; updatedAt?: string | null }>(
  items: T[],
  sort: ListSort,
): T[] => {
  const copy = [...items];
  if (sort === 'newest') {
    copy.sort((a, b) => timestampOf(b.createdAt) - timestampOf(a.createdAt) || b.number - a.number);
    return copy;
  }
  if (sort === 'oldest') {
    copy.sort((a, b) => timestampOf(a.createdAt) - timestampOf(b.createdAt) || a.number - b.number);
    return copy;
  }
  copy.sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt) || b.number - a.number);
  return copy;
};

/** Full local view: state split → involvement → labels → text → sort. */
export const filterPullItems = <T extends PullItem>(items: T[], options: PullFilterOptions): T[] => {
  const { tokens, labelTokens } = tokenizeSearch(options.search);
  const out: T[] = [];
  for (const item of applyPullStateView(items, options.state)) {
    if (!matchesPullInvolvement(item, options.involvement, options.viewerLogin)) continue;
    if (!matchesLabelFilter(item.labels, '', labelTokens)) continue;
    if (!matchesAllTokens(pullHaystacks(item), tokens)) continue;
    out.push(item);
  }
  return sortListItems(out, options.sort);
};

/** Full local view: state → involvement → labels (filter + qualifiers) → text → sort. */
export const filterIssueItems = <T extends IssueItem>(items: T[], options: IssueFilterOptions): T[] => {
  const { tokens, labelTokens } = tokenizeSearch(options.search);
  const out: T[] = [];
  for (const item of applyIssueStateView(items, options.state)) {
    if (!matchesIssueInvolvement(item, options.involvement, options.viewerLogin)) continue;
    if (!matchesLabelFilter(item.labels, options.labels, labelTokens)) continue;
    if (!matchesAllTokens(issueHaystacks(item), tokens)) continue;
    out.push(item);
  }
  return sortListItems(out, options.sort);
};

/**
 * Merge server-fetched items into the local collection index by number
 * (incoming wins on conflict) without disturbing the order of existing rows.
 */
export const mergeItemsByNumber = <T extends { number: number }>(base: T[], incoming: T[]): T[] => {
  if (incoming.length === 0) return base;
  const incomingByNumber = new Map<number, T>();
  for (const item of incoming) incomingByNumber.set(item.number, item);
  const merged = base.map((item) => incomingByNumber.get(item.number) ?? item);
  const baseNumbers = new Set(base.map((item) => item.number));
  for (const item of incoming) {
    if (!baseNumbers.has(item.number)) merged.push(item);
  }
  return merged;
};

/** Drop items already shown locally so the remote section never duplicates rows. */
export const excludeNumbers = <T extends { number: number }>(items: T[], seen: Set<number>): T[] =>
  items.filter((item) => !seen.has(item.number));

/**
 * Append a fetched comment page without duplicating ids. Server cursor pages
 * can overlap when new comments land mid-paging, and the client re-sorts for
 * the newest/oldest toggle — dedupe by id keeps one card per comment in
 * stable server order.
 */
export const mergeCommentsById = <T extends { id: number }>(current: T[], incoming: T[]): T[] => {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((comment) => comment.id));
  const merged = [...current];
  for (const comment of incoming) {
    if (seen.has(comment.id)) continue;
    seen.add(comment.id);
    merged.push(comment);
  }
  return merged;
};
