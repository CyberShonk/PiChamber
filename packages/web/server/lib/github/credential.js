/** Per-operation credential pinning (§3.2). See DOCUMENTATION.md. */

import crypto from 'node:crypto';
import { createTtlCache } from './cache.js';

export const VIEWER_CACHE_TTL_MS = 10 * 60_000;

export const fingerprintToken = (host, token) => crypto
  .createHash('sha256')
  .update(`${String(host || '').toLowerCase()}\0${String(token || '')}`, 'utf8')
  .digest('hex');

export const createCredentialStore = ({ ghCli, now = Date.now } = {}) => {
  if (!ghCli || typeof ghCli.getToken !== 'function') {
    throw new Error('createCredentialStore requires ghCli.getToken');
  }
  const viewerCache = createTtlCache({ ttlMs: VIEWER_CACHE_TTL_MS, maxEntries: 100, now });

  /**
   * Read the token once and run `task` with the pinned credential.
   * `task` receives `{ host, token, fingerprint }`.
   */
  const withPinnedCredential = async (host, task) => {
    const normalizedHost = String(host || '').trim().toLowerCase();
    const token = await ghCli.getToken(normalizedHost);
    const fingerprint = fingerprintToken(normalizedHost, token);
    return task({ host: normalizedHost, token, fingerprint });
  };

  /**
   * Resolve the viewer login for a pinned credential, caching successes per
   * fingerprint. `loader` performs the actual `GET /user` and must resolve
   * to `{ login, id, avatarUrl, name }` or throw.
   */
  const getViewer = async (credential, loader) => {
    const key = `viewer:${credential.fingerprint}`;
    return viewerCache.getOrLoad(key, loader).then((record) => record.value);
  };

  const invalidateViewer = (credential = null) => {
    if (credential) viewerCache.delete(`viewer:${credential.fingerprint}`);
    else viewerCache.clear();
  };

  return { withPinnedCredential, getViewer, invalidateViewer, fingerprintToken };
};
