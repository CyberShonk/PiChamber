/** Native-fetch REST + GraphQL client (§3.3, §5.1). See DOCUMENTATION.md. */

import { createRateLimitWindows, createTtlCache } from './cache.js';
import { failed, rateLimited, redactSecrets, unavailable } from './errors.js';

export const REQUEST_TIMEOUT_MS = 8000;
const ETAG_CACHE_ENTRIES = 300;
const MAX_ERROR_MESSAGE_CHARS = 300;

/** v1 ships github.com only. Enterprise stays structurally supported but gated. */
export const SUPPORTED_HOSTS = Object.freeze(['github.com']);

export const isSupportedHost = (host) => SUPPORTED_HOSTS.includes(String(host || '').trim().toLowerCase());

export const apiBaseForHost = (host) => {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === 'github.com') return 'https://api.github.com';
  return `https://${normalized}/api/v3`;
};

export const graphqlEndpointForHost = (host) => {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === 'github.com') return 'https://api.github.com/graphql';
  return `https://${normalized}/api/graphql`;
};

const expectedApiHost = (host) => {
  try {
    return new URL(apiBaseForHost(host)).host.toLowerCase();
  } catch {
    return '';
  }
};

const parseRetryAt = (headers, now) => {
  const retryAfter = headers.get('retry-after');
  if (retryAfter != null && retryAfter !== '') {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return now() + Math.min(seconds, 3600) * 1000;
    }
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset != null && reset !== '') {
    const epochSeconds = Number.parseFloat(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      return Math.max(epochSeconds * 1000, now() + 1000);
    }
  }
  return now() + 60_000;
};

const looksLikeRateLimit = (status, headers, bodyText) => {
  if (status !== 403 && status !== 429) return false;
  if (headers.get('x-ratelimit-remaining') === '0') return true;
  if (headers.get('retry-after') != null) return true;
  return /rate limit|secondary|abuse/i.test(bodyText || '');
};

const parseScopeNames = (message, headers) => {
  const accepted = headers.get('x-accepted-github-permissions');
  if (accepted) {
    return accepted.split(/[,;]/).map((scope) => scope.trim()).filter(Boolean).slice(0, 8);
  }
  const scopes = [];
  const pattern = /`([\w:,-]+)`/g;
  let match = null;
  while ((match = pattern.exec(message || '')) && scopes.length < 8) {
    if (!scopes.includes(match[1])) scopes.push(match[1]);
  }
  return scopes;
};

const truncate = (text, max = MAX_ERROR_MESSAGE_CHARS) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const extractRestMessage = (body) => {
  if (body && typeof body === 'object') {
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const firstDetail = errors.map((entry) => entry?.message).find((message) => typeof message === 'string' && message);
    if (typeof body.message === 'string' && body.message) {
      return firstDetail ? `${body.message}: ${firstDetail}` : body.message;
    }
    if (firstDetail) return firstDetail;
  }
  return '';
};

export const createGitHubClient = ({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = Date.now,
  rateLimits = createRateLimitWindows({ now }),
  etagMaxEntries = ETAG_CACHE_ENTRIES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) => {
  if (typeof fetchImpl !== 'function') {
    throw new Error('createGitHubClient requires a fetch implementation');
  }
  const etagCache = createTtlCache({ ttlMs: 24 * 60 * 60_000, maxEntries: etagMaxEntries, now });

  const mapFailure = async ({ credential, host, response, operation }) => {
    const headers = response.headers instanceof Headers ? response.headers : new Headers(response.headers || {});
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }
    const safeFragment = truncate(redactSecrets(extractRestMessage(body) || bodyText, [credential.token]));
    if (looksLikeRateLimit(response.status, headers, `${safeFragment} ${bodyText ? '' : ''}`)) {
      const retryAt = parseRetryAt(headers, now);
      rateLimits.setRateLimited(host, retryAt);
      throw rateLimited(retryAt);
    }
    if (response.status === 401) {
      throw unavailable('gh-unauthenticated');
    }
    if (response.status === 403) {
      const message = extractRestMessage(body) || bodyText;
      if (/scope|permission|resource not accessible|not accessible by/i.test(message)) {
        throw unavailable('scope-missing', { scopes: parseScopeNames(message, headers), host });
      }
      throw unavailable('no-access', { host });
    }
    if (response.status === 404) {
      throw unavailable('no-access', { host });
    }
    if (response.status === 422 && safeFragment) {
      throw failed(`GitHub rejected the request: ${safeFragment}`);
    }
    if (response.status >= 500) {
      throw failed(`GitHub is temporarily unavailable (HTTP ${response.status} during ${operation}).`);
    }
    throw failed(safeFragment ? `GitHub request failed during ${operation}: ${safeFragment}` : `GitHub request failed during ${operation} (HTTP ${response.status}).`);
  };

  const request = async ({
    credential,
    host,
    method = 'GET',
    path,
    query = null,
    body = undefined,
    accept = 'application/vnd.github+json',
    operation = 'request',
    signal = null,
    useEtag = true,
  }) => {
    if (!credential || typeof credential.token !== 'string' || !credential.token) {
      throw unavailable('gh-unauthenticated');
    }
    const normalizedHost = String(host || '').trim().toLowerCase();
    if (!isSupportedHost(normalizedHost)) {
      throw unavailable('not-github', { host: normalizedHost });
    }
    const url = new URL(`${apiBaseForHost(normalizedHost)}${path}`);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === null || value === undefined || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    // Host safety: refuse to attach the credential anywhere but the API host.
    if (url.host.toLowerCase() !== expectedApiHost(normalizedHost)) {
      throw unavailable('not-github', { host: normalizedHost });
    }
    const upperMethod = String(method || 'GET').toUpperCase();
    const etagKey = upperMethod === 'GET' && useEtag ? `etag:${credential.fingerprint}:${url.toString()}` : null;
    const cached = etagKey ? etagCache.peekStale(etagKey) : undefined;
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const headers = new Headers({
      Accept: accept,
      Authorization: `Bearer ${credential.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'PiChamber',
    });
    if (cached?.value?.etag) {
      headers.set('If-None-Match', cached.value.etag);
    }
    let response = null;
    try {
      response = await fetchImpl(url.toString(), {
        method: upperMethod,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combinedSignal,
        redirect: 'manual',
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw failed(`GitHub request timed out during ${operation}.`);
      }
      throw failed(`Could not reach GitHub during ${operation}.`);
    }
    if (response.status === 304 && cached) {
      return { status: 200, headers: response.headers, body: cached.value.body, notModified: true };
    }
    if (response.status < 200 || response.status >= 300) {
      throw await mapFailure({ credential, host: normalizedHost, response, operation });
    }
    const contentType = response.headers.get('content-type') || '';
    let parsed = null;
    if (accept.includes('application/vnd.github.diff') || accept.startsWith('text/') || !contentType.includes('json')) {
      parsed = await response.text();
    } else {
      const text = await response.text();
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
    }
    if (etagKey && upperMethod === 'GET') {
      const etag = response.headers.get('etag');
      if (etag) {
        etagCache.set(etagKey, { etag, body: parsed });
      }
    }
    return { status: response.status, headers: response.headers, body: parsed, notModified: false };
  };

  const graphql = async ({ credential, host, query, variables = {}, operation = 'graphql' }) => {
    if (!credential || typeof credential.token !== 'string' || !credential.token) {
      throw unavailable('gh-unauthenticated');
    }
    const normalizedHost = String(host || '').trim().toLowerCase();
    if (!isSupportedHost(normalizedHost)) {
      throw unavailable('not-github', { host: normalizedHost });
    }
    // The isSupportedHost gate above is the host safety check: the endpoint
    // derives purely from the gated host, so no user input can steer it.
    const endpoint = new URL(graphqlEndpointForHost(normalizedHost));
    let response = null;
    try {
      response = await fetchImpl(endpoint.toString(), {
        method: 'POST',
        headers: new Headers({
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential.token}`,
          'User-Agent': 'PiChamber',
        }),
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(requestTimeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw failed(`GitHub request timed out during ${operation}.`);
      }
      throw failed(`Could not reach GitHub during ${operation}.`);
    }
    if (response.status === 403 || response.status === 429) {
      throw await mapFailure({ credential, host: normalizedHost, response, operation });
    }
    if (response.status === 401) throw unavailable('gh-unauthenticated');
    if (response.status < 200 || response.status >= 300) {
      throw await mapFailure({ credential, host: normalizedHost, response, operation });
    }
    let parsed = null;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      throw failed(`GitHub returned an unreadable response during ${operation}.`);
    }
    const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
    if (errors.length > 0) {
      const first = errors[0] || {};
      const type = String(first.type || '');
      const message = truncate(redactSecrets(String(first.message || 'GraphQL error'), [credential.token]));
      if (/rate limit/i.test(message)) {
        const retryAt = now() + 60_000;
        rateLimits.setRateLimited(normalizedHost, retryAt);
        throw rateLimited(retryAt);
      }
      if (type === 'NOT_FOUND' || /not found|could not resolve/i.test(message)) {
        throw unavailable('no-access', { host: normalizedHost });
      }
      if (/scope|permission|forbidden/i.test(message)) {
        throw unavailable('scope-missing', { host: normalizedHost });
      }
      throw failed(`GitHub request failed during ${operation}: ${message}`);
    }
    return { status: response.status, headers: response.headers, body: parsed?.data ?? null };
  };

  return {
    request,
    graphql,
    rateLimits,
    isRateLimited: (host) => rateLimits.isRateLimited(host),
    SUPPORTED_HOSTS,
    isSupportedHost,
    apiBaseForHost,
  };
};
