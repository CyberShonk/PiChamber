/**
 * Pure body-length helpers shared by the issue/PR collapsible bodies.
 * Bodies past these sizes collapse behind a "Show more" fade instead of
 * mounting the full sanitized HTML on first paint.
 */

/** Bodies past this size collapse behind a "Show more" fade instead of per-comment toggles. */
export const LONG_COMMENT_BODY_CHARS = 3000;
export const LONG_COMMENT_BODY_LINES = 60;

/** True when a comment body is long enough to collapse behind "Show more". */
export const isLongCommentBody = (body: string | null | undefined): boolean => {
  if (!body) return false;
  if (body.length > LONG_COMMENT_BODY_CHARS) return true;
  return body.split('\n').length > LONG_COMMENT_BODY_LINES;
};

/** Rendered HTML past this size also collapses (tag-heavy bodies with short markdown). */
export const LONG_HTML_CHARS = 12_000;

/** Short `owner/repo` for header labels and agent prompts (`host/owner/repo` → `owner/repo`). */
export const shortRepoRef = (ref: string): string => {
  const parts = ref.split('/');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : ref;
};

/** True for automation authors (collapses into the bot-comment group toggle). */
export const isBotLogin = (login?: string | null): boolean =>
  Boolean(login && (/\[bot\]$/i.test(login) || login.toLowerCase() === 'github-actions'));
