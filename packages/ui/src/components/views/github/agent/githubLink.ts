import { useInputStore } from '@/sync/input-store';

/**
 * Shared composer-link helpers for GitHub issues and pull requests.
 *
 * The "linked chip" the task names is the transcript chip rendered from the
 * existing `application/vnd.github.issue-link` /
 * `application/vnd.github.pull-request-link` parts (see
 * `message/normalizeUserDisplayParts.ts`, `message/UserMessageAttachments.tsx`,
 * `FileAttachment.tsx`): a synthetic text part of the form
 * `GitHub issue context (JSON)\n{...}` is converted into that attachment on
 * display, while the full quoted server payload travels as a second synthetic
 * part so the agent receives it on send. The draft attachment strip has no
 * ad-hoc context-chip kind (its cards own file-upload lifecycles), so the
 * pulls precedent (`pulls/useSendGitHubContextToComposer.ts`) is followed:
 * visible reference text the user reviews plus synthetic payload parts.
 *
 * `insertGitHubContextIntoComposer` takes its store actions as injected
 * callbacks so unit tests stay self-contained; UI callers pass
 * `createInputStoreGitHubComposerActions()`. The PR surface reuses this
 * module unchanged with `kind: 'pr'`.
 */

export const GITHUB_ISSUE_CONTEXT_PREFIX = 'GitHub issue context (JSON)';
export const GITHUB_PR_CONTEXT_PREFIX = 'GitHub pull request context (JSON)';

export type GitHubLinkKind = 'issue' | 'pr';

export const buildGitHubLinkVisibleText = (input: {
  kind: GitHubLinkKind;
  number: number;
  title: string;
}): string => {
  const label = input.kind === 'pr' ? 'PR' : 'Issue';
  const title = input.title.trim() || '(untitled)';
  return `${label} #${input.number}: ${title}`;
};

/** Synthetic link part; shape must stay parseable by `normalizeUserDisplayParts`. */
export const buildGitHubLinkSyntheticText = (input: {
  kind: GitHubLinkKind;
  number: number;
  title: string;
  url: string;
}): string => {
  const title = input.title.trim() || '(untitled)';
  if (input.kind === 'pr') {
    return `${GITHUB_PR_CONTEXT_PREFIX}\n${JSON.stringify({ pr: { number: input.number, title, url: input.url } })}`;
  }
  return `${GITHUB_ISSUE_CONTEXT_PREFIX}\n${JSON.stringify({ issue: { number: input.number, title, url: input.url } })}`;
};

export type GitHubComposerActions = {
  appendVisibleText: (text: string) => void;
  appendSyntheticText: (text: string) => void;
};

/** Live input-store wiring for `insertGitHubContextIntoComposer`. */
export const createInputStoreGitHubComposerActions = (): GitHubComposerActions => ({
  appendVisibleText: (text) => {
    useInputStore.getState().setPendingInputText(text, 'append');
  },
  appendSyntheticText: (text) => {
    const store = useInputStore.getState();
    const existing = store.pendingSyntheticParts ?? [];
    store.setPendingSyntheticParts([...existing, { text, synthetic: true }]);
  },
});

/**
 * Insert a linked issue/PR into the composer: a visible reference line the
 * user reviews (never auto-sent — sending stays with the user) plus the
 * chip-identifying synthetic part and the full quoted context payload.
 */
export const insertGitHubContextIntoComposer = (
  input: {
    kind: GitHubLinkKind;
    number: number;
    title: string;
    url: string;
    /** Full quoted payload from the server `context` route. */
    contextText: string;
  },
  actions: GitHubComposerActions,
): void => {
  actions.appendVisibleText(buildGitHubLinkVisibleText(input));
  actions.appendSyntheticText(buildGitHubLinkSyntheticText(input));
  if (input.contextText.trim()) {
    actions.appendSyntheticText(input.contextText);
  }
};
