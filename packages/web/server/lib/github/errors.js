/** GitHub error taxonomy (§5.1). See DOCUMENTATION.md for kinds and HTTP mapping. */

export const UNAVAILABLE_REASONS = Object.freeze([
  'gh-missing',
  'gh-outdated',
  'gh-unauthenticated',
  'not-github',
  'no-repository',
  'no-access',
  'scope-missing',
]);

export class GitHubIntegrationError extends Error {
  constructor(kind, details = {}) {
    super(typeof details.message === 'string' && details.message ? details.message : kind);
    this.name = 'GitHubIntegrationError';
    this.kind = kind;
    if (kind === 'unavailable') {
      this.reason = details.reason;
      if (Array.isArray(details.scopes)) this.scopes = [...details.scopes];
      if (typeof details.host === 'string') this.host = details.host;
    } else if (kind === 'rate-limited') {
      this.retryAt = details.retryAt;
    }
    if (details.stale !== undefined) this.stale = details.stale;
    if (details.fetchedAt !== undefined) this.fetchedAt = details.fetchedAt;
  }
}

export const unavailable = (reason, extra = {}) => {
  if (!UNAVAILABLE_REASONS.includes(reason)) {
    throw new Error(`Unknown unavailable reason: ${reason}`);
  }
  const message = typeof extra.message === 'string' && extra.message
    ? extra.message
    : defaultUnavailableMessage(reason, extra);
  return new GitHubIntegrationError('unavailable', { ...extra, reason, message });
};

export const rateLimited = (retryAt, extra = {}) => new GitHubIntegrationError('rate-limited', {
  ...extra,
  retryAt: Number.isFinite(retryAt) ? retryAt : Date.now() + 60_000,
  message: 'GitHub rate limit reached. Try again shortly.',
});

export const failed = (message, extra = {}) => new GitHubIntegrationError('failed', {
  ...extra,
  message: typeof message === 'string' && message ? message : 'GitHub request failed',
});

/**
 * Client input validation failure. Same `{ kind: 'failed' }` body shape, but
 * mapped to HTTP 400 so callers can distinguish bad input from upstream
 * failures. Used for malformed params and payloads, never for GitHub
 * API responses.
 */
export const inputError = (message) => {
  const error = failed(message);
  error.statusCode = 400;
  return error;
};

const defaultUnavailableMessage = (reason, extra = {}) => {
  switch (reason) {
    case 'gh-missing':
      return 'GitHub CLI (gh) is not installed on the machine running PiChamber.';
    case 'gh-outdated':
      return `GitHub CLI (gh) is too old${extra.version ? ` (found ${extra.version})` : ''}. Update gh and try again.`;
    case 'gh-unauthenticated':
      return 'GitHub CLI is not signed in. Run `gh auth login` on the machine running PiChamber, then check again.';
    case 'not-github':
      return 'This repository does not use a github.com remote.';
    case 'no-repository':
      return 'This directory is not inside a git repository.';
    case 'no-access':
      return 'The signed-in GitHub account cannot access this repository.';
    case 'scope-missing':
      return `The GitHub token is missing required scope${extra.scopes?.length ? `: ${extra.scopes.join(', ')}` : ''}.`;
    default:
      return 'GitHub is unavailable.';
  }
};

export const isGitHubIntegrationError = (error) => error instanceof GitHubIntegrationError;

export const toHttpStatus = (error) => {
  if (!isGitHubIntegrationError(error)) return 502;
  if (typeof error.statusCode === 'number') return error.statusCode;
  if (error.kind === 'rate-limited') return 429;
  if (error.kind === 'failed') return 502;
  switch (error.reason) {
    case 'scope-missing':
      return 403;
    case 'not-github':
    case 'no-repository':
    case 'no-access':
      return 404;
    case 'gh-missing':
    case 'gh-outdated':
    case 'gh-unauthenticated':
    default:
      return 503;
  }
};

export const toErrorBody = (error) => {
  if (!isGitHubIntegrationError(error)) {
    return { error: { kind: 'failed', message: redactSecrets(String(error?.message || 'GitHub request failed'), []) } };
  }
  if (error.kind === 'unavailable') {
    const body = { error: { kind: 'unavailable', reason: error.reason } };
    if (Array.isArray(error.scopes)) body.error.scopes = [...error.scopes];
    if (typeof error.host === 'string') body.error.host = error.host;
    return body;
  }
  if (error.kind === 'rate-limited') {
    return { error: { kind: 'rate-limited', retryAt: error.retryAt } };
  }
  return { error: { kind: 'failed', message: String(error.message || 'GitHub request failed') } };
};

/**
 * Replace every occurrence of a secret with `[redacted]`. Used before any
 * string derived from credentials-adjacent data crosses into logs, errors,
 * or HTTP responses. Secrets are never logged in full — only compared.
 */
export const redactSecrets = (text, secrets) => {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
};

export const containsSecret = (haystack, secrets) => {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack ?? '');
  const list = Array.isArray(secrets) ? secrets : [secrets];
  return list.some((secret) => typeof secret === 'string' && secret.length >= 4 && text.includes(secret));
};

/**
 * Map a failed sub-read to a section error body. A failed section keeps its
 * array as `[]` but is never authoritative empty — callers render the error.
 */
export const toSectionError = (error) => {
  try {
    if (isGitHubIntegrationError(error)) return toErrorBody(error).error;
  } catch { /* fall through to generic failed */ }
  return { kind: 'failed', message: 'GitHub request failed' };
};
