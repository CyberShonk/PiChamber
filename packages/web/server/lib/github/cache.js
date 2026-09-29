/** Bounded TTL caches with in-flight coalescing (§5.2). See DOCUMENTATION.md. */

export const createTtlCache = ({ ttlMs = 30_000, maxEntries = 500, now = Date.now } = {}) => {
  const entries = new Map();
  const inFlight = new Map();

  const prune = () => {
    const at = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      // LRU refresh.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    peek(key) {
      const entry = entries.get(key);
      return entry && entry.expiresAt > now() ? entry.value : undefined;
    },
    /** Last good value even when expired (for stale:true serves). Never throws. */
    peekStale(key) {
      const entry = entries.get(key);
      return entry ? { value: entry.value, fetchedAt: entry.fetchedAt } : undefined;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs, fetchedAt: now() });
      prune();
    },
    delete(key) {
      entries.delete(key);
    },
    invalidate(predicate) {
      if (typeof predicate !== 'function') {
        entries.clear();
        return;
      }
      for (const key of [...entries.keys()]) {
        if (predicate(key)) entries.delete(key);
      }
    },
    clear() {
      entries.clear();
      inFlight.clear();
    },
    size() {
      return entries.size;
    },
    /**
     * Return the cached value, or run `loader` once for concurrent callers.
     * Only resolved values are stored; rejections never populate the cache.
     */
    async getOrLoad(key, loader) {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) {
        entries.delete(key);
        entries.set(key, cached);
        return { value: cached.value, fetchedAt: cached.fetchedAt, fromCache: true };
      }
      const pending = inFlight.get(key);
      if (pending) {
        const settled = await pending;
        return { value: settled.value, fetchedAt: settled.fetchedAt, fromCache: true };
      }
      const task = (async () => {
        const value = await loader();
        entries.delete(key);
        const record = { value, expiresAt: now() + ttlMs, fetchedAt: now() };
        entries.set(key, record);
        prune();
        return record;
      })();
      inFlight.set(key, task);
      try {
        const record = await task;
        return { value: record.value, fetchedAt: record.fetchedAt, fromCache: false };
      } finally {
        if (inFlight.get(key) === task) inFlight.delete(key);
      }
    },
  };
};

export const createRateLimitWindows = ({ now = Date.now } = {}) => {
  const windows = new Map();
  return {
    isRateLimited(host) {
      const retryAt = windows.get(String(host || '').toLowerCase());
      if (!retryAt) return false;
      if (retryAt <= now()) {
        windows.delete(String(host || '').toLowerCase());
        return false;
      }
      return true;
    },
    getRetryAt(host) {
      return windows.get(String(host || '').toLowerCase()) ?? null;
    },
    setRateLimited(host, retryAt) {
      const at = Number.isFinite(retryAt) ? retryAt : now() + 60_000;
      windows.set(String(host || '').toLowerCase(), at);
    },
    clear(host) {
      if (host) windows.delete(String(host || '').toLowerCase());
      else windows.clear();
    },
  };
};

/**
 * Run `loader` through `cache.getOrLoad`; when the fresh read fails with a
 * rate-limit or transport failure and a last-good value exists, serve it
 * marked `{ stale: true, fetchedAt }` instead of throwing. Any other error
 * propagates unchanged so failures never masquerade as authoritative data.
 */
/** Fingerprint + repo prefix shared by every per-repo cache key. */
export const repoCachePrefix = (credential, repo) => `${credential?.fingerprint || ''}:${repo.host}/${repo.owner}/${repo.repo}`;

/**
 * Invalidate predicate for fingerprint + repo (+number) scoped caches.
 * `matchNumberInside` preserves the pulls detail oldest behavior where a
 * number can also appear mid-key; over-invalidation only costs a refetch.
 */
export const repoInvalidatePredicate = ({ fingerprint = '', repo = null, number = null, matchNumberInside = false } = {}) => (key) => {
  if (fingerprint && !key.startsWith(fingerprint)) return false;
  if (repo && !key.includes(`${repo.host}/${repo.owner}/${repo.repo}`)) return false;
  if (number !== null && number !== undefined) {
    const token = `:${number}`;
    if (!key.endsWith(token) && !(matchNumberInside && key.includes(`${token}:`))) return false;
  }
  return true;
};

/** Opaque page cursor: advance only when the raw page came back full. */
export const nextCursor = (items, page, perPage) => ((Array.isArray(items) ? items.length : 0) === perPage ? String(page + 1) : null);
export const readWithStaleFallback = async (cache, key, loader, { staleOnRateLimit = true } = {}) => {
  try {
    const record = await cache.getOrLoad(key, loader);
    return { value: record.value, fetchedAt: record.fetchedAt, stale: false };
  } catch (error) {
    const usable = error?.kind === 'failed'
      || (staleOnRateLimit && error?.kind === 'rate-limited');
    if (!usable) throw error;
    const lastGood = cache.peekStale(key);
    if (!lastGood) throw error;
    return { value: lastGood.value, fetchedAt: lastGood.fetchedAt, stale: true, error };
  }
};
