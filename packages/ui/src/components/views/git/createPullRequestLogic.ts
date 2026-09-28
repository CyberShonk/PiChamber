/**
 * Pure decisions for the Git-surface create-pull-request UI.
 *
 * Kept free of React/store imports so unit tests stay self-contained.
 * The app never generates pull-request titles or bodies: the form only
 * offers the branches, validation, and submit labels derived here.
 */

/** Fork-aware default base: the upstream default on forks, else the repo default, else `main`. */
export const resolveCreatePrDefaultBase = (input: {
  isFork: boolean;
  upstreamDefaultBranch: string | null | undefined;
  defaultBranch: string | null | undefined;
}): string => {
  if (input.isFork && input.upstreamDefaultBranch?.trim()) return input.upstreamDefaultBranch.trim();
  if (input.defaultBranch?.trim()) return input.defaultBranch.trim();
  return 'main';
};

/** In-memory draft key for typed text that survives collapsing the form. */
export const createPrDraftKey = (directory: string, branch: string): string => `${directory}\n${branch}`;

/**
 * Base-branch options from `branches.all` (the `useGitStore` branch list).
 *
 * Only remote refs are offered — a PR base must exist on the remote.
 * `remotes/<remote>/<name>` collapses to `<name>`, deduped across remotes,
 * excluding the head branch. The default branch sorts first; the rest sort
 * alphabetically. An empty result means no branch list is available and the
 * caller falls back to a free-text entry.
 */
export const deriveBaseBranchOptions = (input: {
  allBranches: readonly string[] | null | undefined;
  headBranch: string;
  defaultBranch: string | null | undefined;
}): string[] => {
  const head = input.headBranch.trim();
  // No list at all (still loading or never fetched): the caller falls back
  // to a free-text entry instead of a misleading single-option dropdown.
  if (input.allBranches == null) return [];
  const seen = new Set<string>();
  const options: string[] = [];
  for (const ref of input.allBranches) {
    if (!ref.startsWith('remotes/')) continue;
    const withoutPrefix = ref.slice('remotes/'.length);
    const slash = withoutPrefix.indexOf('/');
    if (slash <= 0) continue;
    const name = withoutPrefix.slice(slash + 1).trim();
    if (!name || name === head || seen.has(name)) continue;
    seen.add(name);
    options.push(name);
  }
  options.sort((a, b) => a.localeCompare(b));
  // A list with no remote refs is no usable list either.
  if (options.length === 0) return [];
  const fallback = input.defaultBranch?.trim() ?? '';
  if (fallback && fallback !== head) {
    return [fallback, ...options.filter((name) => name !== fallback)];
  }
  return options;
};

export type CreatePrMode = 'ready' | 'draft';

export const CREATE_PR_MODES: Array<{ id: CreatePrMode; label: string; description: string }> = [
  { id: 'ready', label: 'Create pull request', description: 'Open the pull request for review' },
  { id: 'draft', label: 'Create draft pull request', description: 'Mark the pull request as not ready for review' },
];

/** Split-button label for the create mode (mirrors the merge-method menu pattern). */
export const createPrSubmitLabel = (mode: CreatePrMode): string =>
  mode === 'draft' ? 'Create draft pull request' : 'Create pull request';

/**
 * In-memory (never persisted) drafts for the create-pull-request form, keyed
 * by `createPrDraftKey(directory, branch)`. Collapsing the form unmounts it,
 * so typed text lives here and is restored on expand; a successful create
 * clears the entry. Module state (not zustand) keeps the collapsed row
 * subscription-free.
 */
type CreatePullRequestDraft = {
  title: string;
  body: string;
  /** Null means "follow the resolved default base". */
  base: string | null;
  mode: CreatePrMode;
};

const createPrDrafts = new Map<string, CreatePullRequestDraft>();

export const readCreatePrDraft = (key: string): CreatePullRequestDraft | null => createPrDrafts.get(key) ?? null;

export const writeCreatePrDraft = (key: string, draft: CreatePullRequestDraft): void => {
  createPrDrafts.set(key, draft);
};

export const clearCreatePrDraft = (key: string): void => {
  createPrDrafts.delete(key);
};
