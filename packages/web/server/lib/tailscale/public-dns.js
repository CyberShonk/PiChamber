/**
 * Public DNS readiness check for Tailscale Funnel (public) mode.
 *
 * When Funnel is first enabled, Tailscale takes ~10-15 minutes to publish
 * the public DNS record for `<machine>.<tailnet>.ts.net`. The host's own
 * resolver must NOT be used to check this:
 *
 * - A host using MagicDNS resolves the name to the tailnet IP immediately,
 *   so it can never show public readiness.
 * - A host resolver may also have cached the negative (NXDOMAIN) answer.
 *
 * Instead this module queries public resolvers (1.1.1.1, 8.8.8.8) directly.
 * It sends only the hostname — no credentials, nothing else.
 */

import dns from 'node:dns';

const PUBLIC_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];
const PUBLIC_DNS_TIMEOUT_MS = 3000;

const isNotFoundCode = (code) => code === 'ENOTFOUND' || code === 'ENODATA';

/**
 * Create a `resolvePublicDns` function with an injectable Resolver factory
 * (tests inject a fake; production uses `dns.promises.Resolver`).
 *
 * Returns `async (hostname) => 'found' | 'not-found' | 'error'`. Never throws.
 */
export const createResolvePublicDns = ({ createResolver } = {}) => {
  const newResolver = createResolver
    || ((options) => new dns.promises.Resolver(options));
  return async (hostname) => {
    try {
      if (typeof hostname !== 'string' || hostname.trim().length === 0) return 'error';
      const name = hostname.trim().replace(/\.$/, '');
      if (!name) return 'error';
      let resolver = null;
      try {
        resolver = newResolver({ timeout: PUBLIC_DNS_TIMEOUT_MS, tries: 1 });
      } catch {
        return 'error';
      }
      try {
        resolver.setServers(PUBLIC_DNS_SERVERS);
      } catch {
        return 'error';
      }
      const settled = await Promise.allSettled([
        resolver.resolve4(name),
        resolver.resolve6(name),
      ]);
      try {
        resolver.cancel?.();
      } catch {
      }
      const found = settled.some(
        (entry) => entry.status === 'fulfilled' && Array.isArray(entry.value) && entry.value.length > 0,
      );
      if (found) return 'found';
      const allNotFound = settled.length > 0 && settled.every(
        (entry) => entry.status === 'rejected' && isNotFoundCode(entry.reason?.code),
      );
      if (allNotFound) return 'not-found';
      return 'error';
    } catch {
      return 'error';
    }
  };
};

/** Production resolver: public resolvers, 3s timeout, single try. Never throws. */
export const defaultResolvePublicDns = createResolvePublicDns();
