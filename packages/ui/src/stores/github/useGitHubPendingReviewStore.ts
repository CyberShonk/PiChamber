import React from 'react';
import { create } from 'zustand';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { PullReviewVerdict } from '@/components/views/github/pulls/pullLogic';

/**
 * Pending pull-request review state: line comments waiting to be sent with
 * the review, the review summary, the chosen verdict, and the standalone
 * comment draft. Keyed by `${repo}#${number}`.
 *
 * Deliberately in-memory (never persisted): a half-written review is
 * invisible to everyone else until the single submit request carries the
 * summary, verdict, and every line comment together, so there is no
 * server-side draft to reconcile — persisting it would promise durability
 * for state whose submit contract is all-or-nothing. Drafts survive popover
 * close and mode switches within the session; a reload starts clean.
 */

export type PendingReviewSide = 'LEFT' | 'RIGHT';

export type PendingReviewLineComment = {
  id: string;
  path: string;
  body: string;
  /** Real file line (new side by default); omitted only when unknown. */
  line?: number;
  side?: PendingReviewSide;
};

type PendingReviewEntry = {
  comments: PendingReviewLineComment[];
  summary: string;
  verdict: PullReviewVerdict;
  commentDraft: string;
};

export const pendingReviewKey = (repo: string, number: number): string => `${repo}#${number}`;

// Stable fallbacks: selectors must return referentially stable values, never
// a fresh object/array per call (that loops zustand snapshots with
// "Maximum update depth exceeded").
const EMPTY_COMMENTS: readonly PendingReviewLineComment[] = Object.freeze([]);
const EMPTY_ENTRY: PendingReviewEntry = Object.freeze({
  comments: EMPTY_COMMENTS as PendingReviewLineComment[],
  summary: '',
  verdict: 'comment',
  commentDraft: '',
});

let pendingCommentSequence = 0;

const nextPendingReviewCommentId = (): string => {
  pendingCommentSequence += 1;
  return `pending-review-comment-${pendingCommentSequence}`;
};

type PendingReviewStoreState = {
  entries: Record<string, PendingReviewEntry>;
  addComment: (repo: string, number: number, comment: Omit<PendingReviewLineComment, 'id'> & { id?: string }) => string;
  removeComment: (repo: string, number: number, commentId: string) => void;
  removeComments: (repo: string, number: number, commentIds: readonly string[]) => void;
  clearComments: (repo: string, number: number) => void;
  setSummary: (repo: string, number: number, summary: string) => void;
  /** Clear the summary only when it still equals the submitted body: text
   * revised while the submit was in flight is new work, not leftovers. */
  clearSummary: (repo: string, number: number, submittedBody: string) => void;
  setVerdict: (repo: string, number: number, verdict: PullReviewVerdict) => void;
  setCommentDraft: (repo: string, number: number, draft: string) => void;
  clearCommentDraft: (repo: string, number: number) => void;
  resetForRuntimeSwitch: () => void;
};

const entryFor = (state: PendingReviewStoreState, key: string): PendingReviewEntry =>
  state.entries[key] ?? EMPTY_ENTRY;

const patchEntry = (
  state: PendingReviewStoreState,
  key: string,
  patch: Partial<PendingReviewEntry>,
): Record<string, PendingReviewEntry> => ({
  // Only the comments array is cloned, and only when the patch replaces it;
  // scalar patches (summary/verdict/draft) keep every other reference.
  ...state.entries,
  [key]: { ...entryFor(state, key), ...patch },
});

export const useGitHubPendingReviewStore = create<PendingReviewStoreState>()((set, get) => ({
  entries: {},

  addComment: (repo, number, comment) => {
    const id = comment.id ?? nextPendingReviewCommentId();
    const key = pendingReviewKey(repo, number);
    set((state) => ({
      entries: patchEntry(state, key, {
        comments: [...entryFor(state, key).comments, { ...comment, id }],
      }),
    }));
    return id;
  },

  removeComment: (repo, number, commentId) => {
    const key = pendingReviewKey(repo, number);
    set((state) => {
      const current = entryFor(state, key).comments;
      const remaining = current.filter((entry) => entry.id !== commentId);
      if (remaining.length === current.length) return state;
      if (remaining.length === 0 && entryFor(state, key).summary === '' && entryFor(state, key).commentDraft === '') {
        const next = { ...state.entries };
        delete next[key];
        return { entries: next };
      }
      return { entries: patchEntry(state, key, { comments: remaining }) };
    });
  },

  removeComments: (repo, number, commentIds) => {
    if (commentIds.length === 0) return;
    const key = pendingReviewKey(repo, number);
    const submitted = new Set(commentIds);
    set((state) => {
      const current = entryFor(state, key).comments;
      const remaining = current.filter((entry) => !submitted.has(entry.id));
      if (remaining.length === current.length) return state;
      return { entries: patchEntry(state, key, { comments: remaining }) };
    });
  },

  clearComments: (repo, number) => {
    const key = pendingReviewKey(repo, number);
    set((state) => {
      if ((state.entries[key]?.comments.length ?? 0) === 0) return state;
      return { entries: patchEntry(state, key, { comments: [] }) };
    });
  },

  setSummary: (repo, number, summary) => {
    const key = pendingReviewKey(repo, number);
    if (get().entries[key]?.summary === summary) return;
    set((state) => ({ entries: patchEntry(state, key, { summary }) }));
  },

  clearSummary: (repo, number, submittedBody) => {
    const key = pendingReviewKey(repo, number);
    set((state) => {
      if (entryFor(state, key).summary !== submittedBody) return state;
      return { entries: patchEntry(state, key, { summary: '' }) };
    });
  },

  setVerdict: (repo, number, verdict) => {
    const key = pendingReviewKey(repo, number);
    if (get().entries[key]?.verdict === verdict) return;
    set((state) => ({ entries: patchEntry(state, key, { verdict }) }));
  },

  setCommentDraft: (repo, number, draft) => {
    const key = pendingReviewKey(repo, number);
    if (get().entries[key]?.commentDraft === draft) return;
    set((state) => ({ entries: patchEntry(state, key, { commentDraft: draft }) }));
  },

  clearCommentDraft: (repo, number) => {
    const key = pendingReviewKey(repo, number);
    set((state) => {
      if (entryFor(state, key).commentDraft === '') return state;
      return { entries: patchEntry(state, key, { commentDraft: '' }) };
    });
  },

  resetForRuntimeSwitch: () => set({ entries: {} }),
}));

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(() => {
    useGitHubPendingReviewStore.getState().resetForRuntimeSwitch();
  });
}

/** Pending line comments for a PR; stable empty array when there are none. */
export const usePendingReviewComments = (repo: string, number: number): readonly PendingReviewLineComment[] =>
  useGitHubPendingReviewStore((state) => state.entries[pendingReviewKey(repo, number)]?.comments ?? EMPTY_COMMENTS);

export const usePendingReviewSummary = (repo: string, number: number): string =>
  useGitHubPendingReviewStore((state) => state.entries[pendingReviewKey(repo, number)]?.summary ?? '');

export const usePendingReviewVerdict = (repo: string, number: number): PullReviewVerdict =>
  useGitHubPendingReviewStore((state) => state.entries[pendingReviewKey(repo, number)]?.verdict ?? 'comment');

export const usePendingCommentDraft = (repo: string, number: number): string =>
  useGitHubPendingReviewStore((state) => state.entries[pendingReviewKey(repo, number)]?.commentDraft ?? '');

export const usePendingReviewCount = (repo: string, number: number): number =>
  useGitHubPendingReviewStore((state) => state.entries[pendingReviewKey(repo, number)]?.comments.length ?? 0);

/** Debounce for persisting keystroke drafts to the shared store. */
const COMMENT_DRAFT_PERSIST_MS = 300;

/**
 * Comment draft with local keystroke state. Typing updates local state only;
 * the shared store (which every pending-review selector re-reads) persists
 * debounced plus on unmount/blur, so drafts still survive navigation and
 * tab switches without a store write per keystroke.
 */
export const useDebouncedCommentDraft = (
  repo: string,
  number: number,
): { draft: string; onDraftChange: (value: string) => void; flushDraft: () => void } => {
  const key = pendingReviewKey(repo, number);
  const stored = useGitHubPendingReviewStore((state) => state.entries[key]?.commentDraft ?? '');
  const [draft, setDraft] = React.useState(stored);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const storedRef = React.useRef(stored);
  storedRef.current = stored;

  // A posted-then-cleared draft (or a draft restored after navigation)
  // replaces local text only when local text is untouched since.
  const lastPersistedRef = React.useRef(stored);
  React.useEffect(() => {
    if (draftRef.current === lastPersistedRef.current && stored !== lastPersistedRef.current) {
      lastPersistedRef.current = stored;
      setDraft(stored);
    }
  }, [stored]);

  const flushDraft = React.useCallback(() => {
    const value = draftRef.current;
    if (value === lastPersistedRef.current) return;
    lastPersistedRef.current = value;
    useGitHubPendingReviewStore.getState().setCommentDraft(repo, number, value);
  }, [repo, number]);

  const onDraftChange = React.useCallback((value: string) => {
    setDraft(value);
  }, []);

  // Debounced persist; unmount flushes so navigation never loses text.
  React.useEffect(() => {
    if (draft === lastPersistedRef.current) return;
    const timer = setTimeout(flushDraft, COMMENT_DRAFT_PERSIST_MS);
    return () => clearTimeout(timer);
  }, [draft, flushDraft]);
  React.useEffect(() => () => flushDraft(), [flushDraft]);

  return { draft, onDraftChange, flushDraft };
};
