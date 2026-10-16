/**
 * Tailnet-path health probe for the Tailscale self-check.
 *
 * Some hosts cannot reach their own MagicDNS name over the normal network
 * path — containers/LXC running tailscaled with `--tun=userspace-networking`
 * have no `tailscale0` interface, and host resolvers may not use MagicDNS —
 * so a direct `fetch()` of `<url>/health` throws (DNS/connect error) even
 * though the `tailscale serve`/`funnel` mapping works fine for tailnet
 * peers. The state would sit at `starting` for the full retry budget and
 * then report `probe_failed` for a mapping that was fine all along.
 *
 * This module tunnels the same credential-free `GET /health` check through
 * the tailscale CLI instead: it spawns `tailscale nc <host> <port>` and runs
 * a real TLS handshake over the child's stdio (wrapped as a Duplex via
 * `stream.Duplex.from`) and sends the request with `node:http` over that
 * TLS socket, so Node parses HTTP (including chunked encoding)
 * and verifies the serve certificate exactly like a normal HTTPS request.
 * Certificate verification stays ON — the serve cert is a valid Let's
 * Encrypt cert for the ts.net name — and no Authorization header or cookie
 * is ever sent.
 *
 * Factory: `createTailscaleNcHealthFetch({ executable, spawnFn })` returns
 * `fetchHealth({ host, port, timeoutMs, signal })`, which never throws: every
 * failure (spawn error, timeout, abort, TLS/HTTP error, oversized or
 * non-JSON body) resolves to `{ ok: false, status: null, body: null,
 * error }`. Success resolves to `{ ok: true, status, body }` where `status`
 * is the HTTP status code and `body` is the parsed JSON (or null when the
 * body is not JSON — callers must still check the status and the server
 * identity themselves). Completion, timeout, abort, and error paths always
 * kill the child and destroy the sockets. Response bodies are capped at
 * 64 KiB (the remainder is drained and dropped).
 */

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import tls from 'node:tls';
import { Duplex } from 'node:stream';

import { TAILSCALE_PROBE_TIMEOUT_MS } from './tailscale.js';

// `/health` is a few hundred bytes; cap well above that so a rogue handler
// piping unbounded output through the serve mapping cannot grow memory.
const NC_PROBE_MAX_BODY_BYTES = 64 * 1024;

export const createTailscaleNcHealthFetch = ({ executable, spawnFn = spawn } = {}) => {
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('createTailscaleNcHealthFetch requires an executable path or command');
  }
  if (typeof spawnFn !== 'function') {
    throw new Error('createTailscaleNcHealthFetch requires a spawn function');
  }

  const fail = (error) => ({ ok: false, status: null, body: null, error });

  return async ({ host, port, timeoutMs = TAILSCALE_PROBE_TIMEOUT_MS, signal } = {}) => {
    if (typeof host !== 'string' || host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return fail('invalid-target');
    }
    if (signal?.aborted) return fail('aborted');
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TAILSCALE_PROBE_TIMEOUT_MS;

    let child = null;
    try {
      child = spawnFn(executable, ['nc', host, String(port)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
      });
    } catch {
      return fail('spawn');
    }
    if (!child || !child.stdout || !child.stdin) {
      try {
        child?.kill?.('SIGKILL');
      } catch {
      }
      return fail('spawn');
    }

    let tunnel = null;
    try {
      tunnel = Duplex.from({ readable: child.stdout, writable: child.stdin });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
      }
      return fail('spawn');
    }
    // Stray stream errors after teardown are expected (e.g. destroying the
    // tunnel aborts the in-flight handshake): every outcome is reported via
    // `done`, never via unhandled stream errors.
    tunnel.on('error', () => {});

    try {
      return await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        let tlsSocket = null;
        let req = null;
        const done = (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };
        const onAbort = () => done(fail('aborted'));
        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          try {
            signal?.removeEventListener?.('abort', onAbort);
          } catch {
          }
          try {
            req?.destroy?.();
          } catch {
          }
          try {
            tlsSocket?.destroy?.();
          } catch {
          }
          try {
            tunnel?.destroy?.();
          } catch {
          }
          try {
            child.kill?.('SIGKILL');
          } catch {
          }
        };

        timer = setTimeout(() => done(fail('timeout')), effectiveTimeoutMs);
        if (timer?.unref) timer.unref();
        try {
          signal?.addEventListener?.('abort', onAbort, { once: true });
        } catch {
        }
        try {
          child.on?.('error', () => done(fail('spawn')));
        } catch {
        }

        let secureSocket = null;
        try {
          secureSocket = tls.connect({ socket: tunnel, servername: host });
        } catch {
          done(fail('tls'));
          return;
        }
        tlsSocket = secureSocket;
        tlsSocket.on('error', () => done(fail('tls')));

        let clientReq = null;
        try {
          clientReq = httpRequest(
            {
              host,
              port,
              path: '/health',
              method: 'GET',
              // Credential-free by construction: no Authorization header, no
              // cookie. The Host header comes from `host` as usual.
              headers: { Accept: 'application/json' },
              // HTTP/1.1 over the already-verified TLS socket. No `agent`:
              // any Agent (including `agent: false`) ignores
              // `createConnection` and would resolve `host` via DNS again.
              createConnection: () => tlsSocket,
            },
            (res) => {
              const chunks = [];
              let bytes = 0;
              res.on('data', (chunk) => {
                if (bytes + chunk.length <= NC_PROBE_MAX_BODY_BYTES) {
                  chunks.push(chunk);
                  bytes += chunk.length;
                }
                // Beyond the cap the rest is drained and dropped.
              });
              res.on('end', () => {
                let body = null;
                try {
                  body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                  body = null;
                }
                done({ ok: true, status: res.statusCode ?? null, body });
              });
              res.on('error', () => done(fail('http')));
            },
          );
        } catch {
          done(fail('request'));
          return;
        }
        req = clientReq;
        req.on('error', () => done(fail('request')));
        try {
          req.end();
        } catch {
          done(fail('request'));
        }
      });
    } catch {
      // Belt and braces: the contract is never-throw, so a synchronous
      // surprise above still resolves to a failure result.
      try {
        child?.kill?.('SIGKILL');
      } catch {
      }
      try {
        tunnel?.destroy?.();
      } catch {
      }
      return fail('internal');
    }
  };
};
