import { describe, expect, it, vi } from 'vitest';

import {
  buildTailscaleServeArgs,
  buildTailscaleUrl,
  checkTailscaleAuthGate,
  classifyApplyFailure,
  classifyServeMapping,
  conflictMessageForPort,
  extractApprovalUrl,
  findServeMappingForPort,
  isPermissionDeniedOutput,
  normalizeTailscaleConfig,
  parseTailscaleStatus,
  resolveTailscaleExecutable,
  tailscaleCommandForPlatform,
  validateTailscaleConfig,
} from './tailscale.js';
import { createTailscaleService } from './service.js';
import { createTailscaleNcHealthFetch } from './nc-probe.js';

describe('tailscale status parsing', () => {
  it('strips the trailing dot from DNSName and reports login state', () => {
    expect(parseTailscaleStatus(JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'machine.tail123.ts.net.', TailscaleIPs: ['100.64.0.1'] },
      CertDomains: ['machine.tail123.ts.net'],
    }))).toEqual({
      running: true,
      loggedIn: true,
      magicDnsName: 'machine.tail123.ts.net',
      httpsCertsAvailable: true,
    });
  });

  it('reports logged out when Self is missing', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NoState' }))).toEqual({
      running: false,
      loggedIn: false,
      magicDnsName: null,
      httpsCertsAvailable: null,
    });
  });

  it('reports unknown cert availability when CertDomains is absent', () => {
    const parsed = parseTailscaleStatus(JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: 'machine.tail123.ts.net.' },
    }));
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.httpsCertsAvailable).toBeNull();
  });

  it('never throws on malformed JSON', () => {
    expect(parseTailscaleStatus('not json{{{')).toEqual({
      running: false,
      loggedIn: false,
      magicDnsName: null,
      httpsCertsAvailable: null,
    });
  });
});

describe('executable resolution', () => {
  it('uses tailscale on posix and tailscale.exe on Windows', () => {
    expect(tailscaleCommandForPlatform('darwin')).toBe('tailscale');
    expect(tailscaleCommandForPlatform('linux')).toBe('tailscale');
    expect(tailscaleCommandForPlatform('win32')).toBe('tailscale.exe');
  });

  it('falls back to the macOS app bundle location', () => {
    const resolved = resolveTailscaleExecutable({ platform: 'darwin', existsSync: () => false });
    expect(resolved.command).toBe('tailscale');
    expect(resolved.fallback).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    const bundled = resolveTailscaleExecutable({
      platform: 'darwin',
      existsSync: (candidate) => candidate === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    });
    expect(bundled.command).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  });

  it('falls back to Program Files on Windows', () => {
    const resolved = resolveTailscaleExecutable({ platform: 'win32', env: {}, existsSync: () => false });
    expect(resolved.command).toBe('tailscale.exe');
    expect(resolved.fallback).toContain('Tailscale');
  });
});

describe('config validation', () => {
  it('accepts partial updates and normalizes defaults', () => {
    expect(validateTailscaleConfig({ enabled: true, mode: 'public', httpsPort: 8443 })).toEqual({ ok: true, errors: [] });
    expect(normalizeTailscaleConfig(null)).toEqual({ enabled: false, mode: 'private', httpsPort: 443 });
    expect(normalizeTailscaleConfig({ enabled: true })).toEqual({ enabled: true, mode: 'private', httpsPort: 443 });
  });

  it('rejects bad mode, port and enabled values', () => {
    expect(validateTailscaleConfig({ mode: 'funnel' }).ok).toBe(false);
    expect(validateTailscaleConfig({ httpsPort: 3000 }).ok).toBe(false);
    expect(validateTailscaleConfig({ httpsPort: '443' }).ok).toBe(false);
    expect(validateTailscaleConfig({ enabled: 'yes' }).ok).toBe(false);
  });
});

describe('auth gate', () => {
  it('allows anything while disabled', () => {
    expect(checkTailscaleAuthGate({ enabled: false, mode: 'public', uiPasswordConfigured: false }).allowed).toBe(true);
  });

  it('requires UI auth for private mode without the escape hatch', () => {
    const blocked = checkTailscaleAuthGate({ enabled: true, mode: 'private', uiPasswordConfigured: false, unsafeUnauthenticatedLanAllowed: false });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('auth_required');
  });

  it('honors the escape hatch for private mode', () => {
    expect(checkTailscaleAuthGate({ enabled: true, mode: 'private', uiPasswordConfigured: false, unsafeUnauthenticatedLanAllowed: true }).allowed).toBe(true);
  });

  it('never honors the escape hatch for public mode', () => {
    const blocked = checkTailscaleAuthGate({ enabled: true, mode: 'public', uiPasswordConfigured: false, unsafeUnauthenticatedLanAllowed: true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('auth_required');
  });

  it('allows both modes with a UI password', () => {
    for (const mode of ['private', 'public']) {
      expect(checkTailscaleAuthGate({ enabled: true, mode, uiPasswordConfigured: true }).allowed).toBe(true);
    }
  });
});

describe('serve status conflict detection', () => {
  const serveStatus = {
    TCP: { 443: { HTTPS: true } },
    Web: {
      'machine.tail123.ts.net:443': {
        Handlers: { '/': 'http://127.0.0.1:3000/' },
      },
      'machine.tail123.ts.net:8443': {
        Handlers: { '/': 'http://127.0.0.1:9999' },
      },
    },
  };

  it('finds mappings keyed by <host>:<port>', () => {
    expect(findServeMappingForPort(serveStatus, 443)?.key).toBe('machine.tail123.ts.net:443');
    expect(findServeMappingForPort(serveStatus, 10000)).toBeNull();
  });

  it('recognizes our own mapping', () => {
    const mapping = findServeMappingForPort(serveStatus, 443);
    expect(classifyServeMapping({ mapping, httpsPort: 443, boundPort: 3000 }).kind).toBe('ours');
  });

  it('flags a foreign mapping as conflict-worthy', () => {
    const mapping = findServeMappingForPort(serveStatus, 8443);
    const classification = classifyServeMapping({ mapping, httpsPort: 8443, boundPort: 3000 });
    expect(classification.kind).toBe('foreign');
    expect(conflictMessageForPort(8443)).toContain('8443');
    expect(conflictMessageForPort(8443)).not.toContain('8443 or 8443');
  });

  it('treats absent mappings as free', () => {
    expect(classifyServeMapping({ mapping: null, httpsPort: 10000, boundPort: 3000 }).kind).toBe('absent');
  });
});

describe('approval and permission detection', () => {
  it('extracts the login approval URL from streamed output', () => {
    expect(extractApprovalUrl('visit https://login.tailscale.com/f/serve?node=abc123 to approve\nwaiting...'))
      .toBe('https://login.tailscale.com/f/serve?node=abc123');
    expect(extractApprovalUrl('visit https://login.tailscale.com/f/funnel?node=xyz to enable funnel.'))
      .toBe('https://login.tailscale.com/f/funnel?node=xyz');
    expect(extractApprovalUrl('all good, no url here')).toBeNull();
  });

  it('detects Linux operator permission errors', () => {
    expect(isPermissionDeniedOutput('Error: access denied: serve config denied')).toBe(true);
    expect(isPermissionDeniedOutput('failed: must be root or operator')).toBe(true);
    expect(isPermissionDeniedOutput('some other failure')).toBe(false);
    expect(classifyApplyFailure('Error: access denied').code).toBe('permission_denied');
    expect(classifyApplyFailure('tailscale is not logged in').code).toBe('not_logged_in');
    expect(classifyApplyFailure('visit https://login.tailscale.com/f/serve?node=x').code).toBe('needs_approval');
    expect(classifyApplyFailure('weird unknown boom')).toBeNull();
  });

  it('builds serve args and public URLs', () => {
    expect(buildTailscaleServeArgs({ mode: 'private', httpsPort: 443, localPort: 3000 }))
      .toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:3000']);
    expect(buildTailscaleServeArgs({ mode: 'public', httpsPort: 8443, localPort: 3000 })[0]).toBe('funnel');
    expect(buildTailscaleUrl({ magicDnsName: 'm.ts.net', httpsPort: 443 })).toBe('https://m.ts.net');
    expect(buildTailscaleUrl({ magicDnsName: 'm.ts.net', httpsPort: 10000 })).toBe('https://m.ts.net:10000');
  });
});

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'mymachine.tailabc.ts.net.' },
  CertDomains: ['mymachine.tailabc.ts.net'],
});

// Stable identity injected into services under test: the probe compares
// `/health`'s serverId against this same id (the relay signing-key serverId
// in production) and only goes `active` on a match.
const TEST_SERVER_ID = 'test-server-id';
const matchingFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ serverId: TEST_SERVER_ID }) });

/** In-memory fs + scripted command runner for lifecycle tests. */
const createHarness = ({ handlers, port = 3000, uiPassword = 'secret', resolvePublicDns } = {}) => {
  const files = new Map();
  const calls = [];
  const fsPromises = {
    readFile: async (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, String(content));
    },
    mkdir: async () => {},
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlink: async (filePath) => {
      if (!files.delete(filePath)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
    },
  };
  const runner = {
    runTailscale: async (args, { onOutput } = {}) => {
      calls.push(args);
      const handler = handlers[args.slice(1).join(' ')] || handlers['*'];
      const result = typeof handler === 'function' ? await handler(args, onOutput) : handler;
      if (result?.stream) {
        for (const chunk of result.stream) onOutput?.(chunk);
      }
      return result || { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
    },
  };
  const service = createTailscaleService({
    dataDir: '/data',
    getPort: () => port,
    isUiAuthEnabled: () => uiPassword !== null,
    isUnsafeUnauthenticatedLanAllowed: () => false,
    runner,
    fsPromises,
    existsSync: () => false,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
    // Fail closed by default: no existing test exercises the tailnet path,
    // and the real `tailscale nc` implementation must never spawn here.
    tailnetHealthFetch: async () => ({ ok: false, status: null, body: null, error: 'disabled-in-test' }),
    // Never touch real DNS in tests: default to not-found (keeps existing
    // tests unchanged); public-DNS tests inject their own sequence.
    resolvePublicDns: resolvePublicDns || (async () => 'not-found'),
    logWarn: () => {},
  });
  return { service, calls, files, fsPromises };
};

describe('tailscale executable resolution', () => {
  it('runs the macOS app-bundle CLI when it exists', async () => {
    const bundle = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    const calls = [];
    const service = createTailscaleService({
      dataDir: '/data',
      getPort: () => 3000,
      platform: 'darwin',
      existsSync: (candidate) => candidate === bundle,
      runner: {
        runTailscale: async (args) => {
          calls.push(args);
          return { ok: true, code: 0, stdout: '{}', stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises: {
        readFile: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
        writeFile: async () => {},
        mkdir: async () => {},
        rename: async () => {},
        unlink: async () => {},
      },
      logWarn: () => {},
    });
    await service.retry();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((args) => args[0] === bundle)).toBe(true);
    service.dispose();
  });
});

describe('status auth gate', () => {
  it('reports per-mode auth-gate flags on the status model', async () => {
    const { service } = createHarness({ uiPassword: null });
    await service.loadConfig();
    const blocked = service.getStatus();
    expect(blocked.authGate).toEqual({ privateAllowed: false, publicAllowed: false });
    service.dispose();
  });

  it('honors the LAN escape hatch for private only', async () => {
    const fsPromises = {
      readFile: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
      writeFile: async () => {},
      mkdir: async () => {},
      rename: async () => {},
      unlink: async () => {},
    };
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => false,
      isUnsafeUnauthenticatedLanAllowed: () => true,
      runner: { runTailscale: async () => ({ ok: true, code: 0, stdout: '{}', stderr: '', spawnError: null, timedOut: false }) },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    expect(service.getStatus().authGate).toEqual({ privateAllowed: true, publicAllowed: false });
    service.dispose();
  });
});

describe('tailscale service lifecycle', () => {
  it('applies on start and probes to active', async () => {
    const { service, calls } = createHarness({
      handlers: {
        'status --json': { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false },
        'serve status --json': { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false },
      },
    });
    service.fetchImpl = undefined;
    const probing = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          calls.push(args);
          if (args.includes('status') && args.includes('--json') && !args.includes('serve')) {
            return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises: {
        readFile: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
        writeFile: async () => {},
        mkdir: async () => {},
        rename: async () => {},
        unlink: async () => {},
      },
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: () => {},
    });
    await probing.loadConfig();
    const result = await probing.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('active');
    expect(result.url).toBe('https://mymachine.tailabc.ts.net');
    expect(calls.some((args) => args.includes('serve') && args.includes('--bg'))).toBe(true);
    expect(probing.getPairingCandidate()).toEqual({ type: 'tailscale', url: 'https://mymachine.tailabc.ts.net', mode: 'private', priority: 20 });
    probing.dispose();
    expect(service).toBeDefined();
  });

  it('keeps a mismatching /health serverId at starting (never active)', async () => {
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) {
          const e = new Error('x');
          e.code = 'ENOENT';
          throw e;
        }
        return memFs.get(p);
      },
      writeFile: async (p, c) => {
        memFs.set(p, String(c));
      },
      mkdir: async () => {},
      rename: async (a, b) => {
        memFs.set(b, memFs.get(a));
        memFs.delete(a);
      },
      unlink: async () => {},
    };
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      // A different machine answering on the ts.net URL: the probe fails,
      // so the mapping is never advertised (dispose clears the re-probe).
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ serverId: 'some-other-server' }) }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('starting');
    expect(result.url).toBeNull();
    expect(service.getPairingCandidate()).toBeNull();
    service.dispose();
  });

  it('reports conflict instead of overwriting a foreign mapping', async () => {
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) {
          const e = new Error('x');
          e.code = 'ENOENT';
          throw e;
        }
        return memFs.get(p);
      },
      writeFile: async (p, c) => {
        memFs.set(p, String(c));
      },
      mkdir: async () => {},
      rename: async (a, b) => {
        memFs.set(b, memFs.get(a));
        memFs.delete(a);
      },
      unlink: async () => {},
    };
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('serve') && args.includes('status')) {
            return {
              ok: true, code: 0, stdout: JSON.stringify({ Web: { 'm.tail.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:9999' } } } }), stderr: '', spawnError: null, timedOut: false,
            };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('conflict');
    expect(result.errorCode).toBe('conflict');
    expect(result.url).toBeNull();
    service.dispose();
  });

  it('blocks enabling without UI auth (public has no escape hatch)', async () => {
    const { service } = createHarness({ uiPassword: null });
    await service.loadConfig();
    await expect(service.setConfig({ enabled: true, mode: 'public', httpsPort: 443 })).rejects.toMatchObject({ code: 'auth_required' });
    service.dispose();
  });

  it('removes its own mapping on shutdown but never a foreign one', async () => {
    const removed = [];
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) {
          const e = new Error('x');
          e.code = 'ENOENT';
          throw e;
        }
        return memFs.get(p);
      },
      writeFile: async (p, c) => {
        memFs.set(p, String(c));
      },
      mkdir: async () => {},
      rename: async (a, b) => {
        memFs.set(b, memFs.get(a));
        memFs.delete(a);
      },
      unlink: async (p) => {
        memFs.delete(p);
      },
    };
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    service.dispose();
    // Re-create (simulates a restart): the persisted record drives removal.
    const service2 = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            // The persisted record still fronts this server: shutdown must
            // verify ownership, then remove it.
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: { 'mymachine.tailabc.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:3000' } } } }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service2.loadConfig();
    await service2.shutdown();
    expect(removed.length).toBeGreaterThan(0);
    expect(removed[0]).toContain('off');
    service2.dispose();
  });

  it('surfaces needs-approval with the approval URL from streamed output', async () => {
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) {
          const e = new Error('x');
          e.code = 'ENOENT';
          throw e;
        }
        return memFs.get(p);
      },
      writeFile: async (p, c) => {
        memFs.set(p, String(c));
      },
      mkdir: async () => {},
      rename: async (a, b) => {
        memFs.set(b, memFs.get(a));
        memFs.delete(a);
      },
      unlink: async () => {},
    };
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args, { onOutput } = {}) => {
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('--bg')) {
            onOutput?.('visit https://login.tailscale.com/f/serve?node=n123 to approve\n');
            return { ok: false, code: 1, stdout: '', stderr: 'visit https://login.tailscale.com/f/serve?node=n123', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('needs-approval');
    expect(result.approvalUrl).toBe('https://login.tailscale.com/f/serve?node=n123');
    service.dispose();
  });

  it('reports unavailable when the executable is missing', async () => {
    const { service } = createHarness({
      handlers: {
        '*': { ok: false, code: null, stdout: '', stderr: '', spawnError: 'spawn tailscale ENOENT', timedOut: false },
      },
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('unavailable');
    expect(result.errorCode).toBe('not_installed');
    service.dispose();
  });

  it('rejects enabling with an invalid port', async () => {
    const { service } = createHarness();
    await service.loadConfig();
    await expect(service.setConfig({ enabled: true, httpsPort: 3000 })).rejects.toMatchObject({ code: 'invalid_config' });
    service.dispose();
  });

  it('retry helper re-runs reconciliation', async () => {
    const spy = vi.fn();
    const { service } = createHarness({
      handlers: {
        '*': async () => {
          spy();
          return { ok: false, code: null, stdout: '', stderr: '', spawnError: 'spawn tailscale ENOENT', timedOut: false };
        },
      },
    });
    await service.loadConfig();
    await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    const before = spy.mock.calls.length;
    await service.retry();
    expect(spy.mock.calls.length).toBeGreaterThan(before);
    service.dispose();
  });
});

describe('tailscale exact port matching (F14)', () => {
  const webFor = (keys) => ({ Web: Object.fromEntries(keys.map((key) => [key, { Handlers: { '/': 'x' } }])) });
  it('matches <host>:<port> exactly and never by suffix', () => {
    const status = webFor(['m.tail.ts.net:443', 'm.tail.ts.net:8443', 'm.tail.ts.net:4433']);
    expect(findServeMappingForPort(status, 443)?.key).toBe('m.tail.ts.net:443');
    expect(findServeMappingForPort(status, 8443)?.key).toBe('m.tail.ts.net:8443');
    expect(findServeMappingForPort(status, 10000)).toBeNull();
    // 443 must not match :4433; a bare port key still matches.
    expect(findServeMappingForPort(webFor(['m.tail.ts.net:4433']), 443)).toBeNull();
    expect(findServeMappingForPort(webFor(['443']), 443)?.key).toBe('443');
    expect(findServeMappingForPort(null, 443)).toBeNull();
  });
});

describe('tailscale blocked-state cleanup (F2)', () => {
  it('removes its own live mapping before reporting blocked', async () => {
    const removed = [];
    const memFs = new Map();
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
        return memFs.get(p);
      },
      writeFile: async (p, c) => { memFs.set(p, String(c)); },
      mkdir: async () => {},
      rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
      unlink: async (p) => { memFs.delete(p); },
    };
    const oursStatus = (port, localPort) => JSON.stringify({
      Web: { [`mymachine.tailabc.ts.net:${port}`]: { Handlers: { '/': `http://127.0.0.1:${localPort}` } } },
    });
    const runner = {
      runTailscale: async (args) => {
        if (args.includes('off')) {
          removed.push(args);
          return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
        }
        if (args.includes('serve') && args.includes('status')) {
          return { ok: true, code: 0, stdout: oursStatus(443, 3000), stderr: '', spawnError: null, timedOut: false };
        }
        return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
      },
    };
    // First enable with a password so the record + mapping exist.
    const enabled = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner,
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: () => {},
    });
    await enabled.loadConfig();
    const active = await enabled.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(active.state).toBe('active');
    enabled.dispose();
    // Restart without the password: reconcile must remove the own mapping,
    // then report blocked.
    const blocked = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => false,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner,
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await blocked.loadConfig();
    const result = await blocked.reconcile();
    expect(result.state).toBe('blocked');
    expect(result.errorCode).toBe('auth_required');
    expect(removed.some((args) => args.includes('serve') && args.includes('off'))).toBe(true);
    blocked.dispose();
  });
});

describe('tailscale disabled/blocked host prerequisites', () => {
  it('reports real host prerequisites while disabled and runs only status --json', async () => {
    const { service, calls } = createHarness({
      handlers: {
        'status --json': { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false },
      },
    });
    await service.loadConfig();
    const result = await service.reconcile();
    expect(result.state).toBe('off');
    expect(result.installed).toBe(true);
    expect(result.running).toBe(true);
    expect(result.loggedIn).toBe(true);
    expect(result.magicDnsName).toBe('mymachine.tailabc.ts.net');
    expect(result.errorCode).toBeNull();
    // Never-enabled stays never-enabled: only `tailscale status --json` ran,
    // no serve/funnel apply (`--bg`) or removal (`off`).
    expect(calls.map((args) => args.slice(1))).toEqual([['status', '--json']]);
    service.dispose();
  });

  it('reports not-installed while disabled when the executable is missing', async () => {
    const { service, calls } = createHarness({
      handlers: {
        '*': { ok: false, code: null, stdout: '', stderr: '', spawnError: 'spawn tailscale ENOENT', timedOut: false },
      },
    });
    await service.loadConfig();
    const result = await service.reconcile();
    expect(result.state).toBe('off');
    expect(result.installed).toBe(false);
    expect(result.running).toBe(false);
    expect(result.loggedIn).toBe(false);
    expect(result.magicDnsName).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(calls.map((args) => args.slice(1))).toEqual([['status', '--json']]);
    service.dispose();
  });

  it('reports host prerequisites while blocked without prerequisite error codes', async () => {
    const harness = createHarness({
      uiPassword: null,
      handlers: {
        'status --json': { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false },
      },
    });
    // setConfig would reject via the auth gate, so persist the enabled
    // config directly like a pre-existing startup config.
    harness.files.set('/data/tailscale-config.json', JSON.stringify({ enabled: true, mode: 'private', httpsPort: 443 }));
    await harness.service.loadConfig();
    const result = await harness.service.reconcile();
    expect(result.state).toBe('blocked');
    expect(result.errorCode).toBe('auth_required');
    expect(result.installed).toBe(true);
    expect(result.running).toBe(true);
    expect(result.loggedIn).toBe(true);
    expect(result.magicDnsName).toBe('mymachine.tailabc.ts.net');
    // Only `tailscale status --json` ran: no serve/funnel apply (`--bg`).
    expect(harness.calls.map((args) => args.slice(1))).toEqual([['status', '--json']]);
    harness.service.dispose();
  });
});

describe('tailscale shutdown ownership verification (F3)', () => {
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const mappingPath = '/data/tailscale-mapping.json';

  it('leaves a foreign mapping alone on shutdown', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    const removed = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: { 'other.tail.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:9999' } } } }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    await service.shutdown();
    expect(removed).toEqual([]);
    service.dispose();
  });

  it('bounds the shutdown query and removal inside the Electron quit timeout', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    const timeouts = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args, options) => {
          timeouts.push(options?.timeoutMs);
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: { 'm.tail.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:3000' } } } }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    await service.shutdown();
    expect(timeouts).toHaveLength(2);
    expect(timeouts.every((ms) => Number.isFinite(ms))).toBe(true);
    // QUIT_SERVER_STOP_TIMEOUT_MS in packages/electron/quit-server-stop.mjs.
    expect(timeouts[0] + timeouts[1]).toBeLessThan(8_000);
    expect(memFs.has(mappingPath)).toBe(false);
    service.dispose();
  });

  it('issues no off and keeps the record when the status query fails', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    const removed = [];
    const warnings = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: false, code: 1, stdout: '', stderr: 'boom', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: (message) => warnings.push(String(message)),
    });
    await service.loadConfig();
    await service.shutdown();
    expect(removed).toEqual([]);
    expect(warnings.some((message) => /status query failed/i.test(message))).toBe(true);
    // Record kept for next-start stale cleanup.
    expect(memFs.has(mappingPath)).toBe(true);
    service.dispose();
  });
});

describe('tailscale unknown-vs-absent status queries (F4)', () => {
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const mappingPath = '/data/tailscale-mapping.json';

  it('refuses to apply on a failed status query and never clears the record', async () => {
    const { memFs, fsPromises } = memFsFor();
    const applied = [];
    const removed = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('--bg')) {
            applied.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('off')) {
            removed.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: false, code: 1, stdout: '', stderr: 'boom', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('error');
    expect(result.errorCode).toBe('status_query_failed');
    expect(applied).toEqual([]);
    expect(removed).toEqual([]);
    expect(memFs.has(mappingPath)).toBe(false);
    service.dispose();
  });

  it('ends a public-to-private switch in error with the old funnel record kept', async () => {
    const { memFs, fsPromises } = memFsFor();
    // Stale public record from a previous run; the funnel status query fails.
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'public', localPort: 3000 }));
    const applied = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('--bg')) {
            applied.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args[0] === 'tailscale' && args[1] === 'funnel' && args.includes('status')) {
            return { ok: false, code: 1, stdout: '', stderr: 'boom', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    // Bypass setConfig persistence: enable private directly, so reconcile
    // must first clean the stale public record (whose query fails).
    const { persistTailscaleConfigForStartup } = await import('./service.js');
    await persistTailscaleConfigForStartup({
      dataDir: '/data',
      patch: { enabled: true, mode: 'private', httpsPort: 443 },
      fsPromises,
      uiPasswordConfigured: true,
    });
    await service.loadConfig();
    const result = await service.reconcile();
    expect(result.state).toBe('error');
    expect(result.errorCode).toBe('status_query_failed');
    // No new mapping applied; the old funnel record stays for cleanup.
    expect(applied).toEqual([]);
    expect(memFs.has(mappingPath)).toBe(true);
    service.dispose();
  });
});

describe('tailscale generation bump cancels in-flight apply (F6)', () => {
  it('aborts the stale apply and removes the mapping it created', async () => {
    const memFs = new Map();
    const mappingPath = '/data/tailscale-mapping.json';
    const fsPromises = {
      readFile: async (p) => {
        if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
        return memFs.get(p);
      },
      writeFile: async (p, c) => { memFs.set(p, String(c)); },
      mkdir: async () => {},
      rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
      unlink: async (p) => { memFs.delete(p); },
    };
    const removed = [];
    let apply443Started = null;
    const apply443Aborted = [];
    const serveWeb = () => JSON.stringify({
      Web: { 'mymachine.tailabc.ts.net:443': { Handlers: { '/': 'http://127.0.0.1:3000' } } },
    });
    const runner = {
      runTailscale: (args, { signal } = {}) => {
        if (args.includes('--bg') && args.includes('--https=443')) {
          apply443Started?.();
          // Block until the generation bump aborts this apply.
          return new Promise((resolve) => {
            const done = (aborted) => resolve({
              ok: false, code: aborted ? null : 0, stdout: '', stderr: '', spawnError: aborted ? 'aborted' : null, timedOut: false,
            });
            if (signal?.aborted) return done(true);
            signal?.addEventListener?.('abort', () => done(true), { once: true });
            apply443Aborted.push(signal);
          });
        }
        if (args.includes('off')) {
          removed.push(args);
          return Promise.resolve({ ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false });
        }
        if (args.includes('serve') && args.includes('status')) {
          return Promise.resolve({ ok: true, code: 0, stdout: serveWeb(), stderr: '', spawnError: null, timedOut: false });
        }
        return Promise.resolve({ ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false });
      },
    };
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner,
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: () => {},
    });
    await service.loadConfig();
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    apply443Started = startedResolve;
    const first = service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    await started;
    // Generation bump while the 443 apply is in flight.
    const second = service.setConfig({ enabled: true, mode: 'private', httpsPort: 8443 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    // The superseded reconcile resolves (never hangs on the killed apply).
    expect(firstResult).toBeDefined();
    expect(apply443Aborted.length).toBe(1);
    expect(apply443Aborted[0]?.aborted).toBe(true);
    // The stale 443 mapping (still live, pointing at our port) is removed;
    // the live generation owns 8443.
    expect(removed.some((args) => args.includes('--https=443') && args.includes('off'))).toBe(true);
    expect(secondResult.state).toBe('active');
    expect(secondResult.url).toBe('https://mymachine.tailabc.ts.net:8443');
    service.dispose();
  });
});

describe('tailscale crash-restart repoint (record-owned mapping on a new port)', () => {
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const serveWeb = (httpsPort, localPort) => JSON.stringify({
    Web: { [`mymachine.tailabc.ts.net:${httpsPort}`]: { Handlers: { '/': `http://127.0.0.1:${localPort}` } } },
  });
  // Simulates a restart on a new bound port with a persisted record+config.
  // `liveLocalPort` fronts the HTTPS port in serve/funnel status; `record`
  // is the persisted mapping record (null = crash left no record).
  const restart = async ({ mode, httpsPort, boundPort, liveLocalPort, record, serveStatus }) => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set('/data/tailscale-config.json', JSON.stringify({ enabled: true, mode, httpsPort }));
    if (record) memFs.set('/data/tailscale-mapping.json', JSON.stringify(record));
    const applied = [];
    const subcommand = mode === 'public' ? 'funnel' : 'serve';
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => boundPort,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('--bg')) {
            applied.push(args);
            return { ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes(subcommand) && args.includes('status')) {
            return { ok: true, code: 0, stdout: serveStatus ?? serveWeb(httpsPort, liveLocalPort), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      resolvePublicDns: async () => 'not-found',
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.reconcile();
    const recordRaw = memFs.has('/data/tailscale-mapping.json') ? memFs.get('/data/tailscale-mapping.json') : null;
    service.dispose();
    return { result, applied, record: recordRaw ? JSON.parse(recordRaw) : null };
  };

  it('repoints a record-owned mapping to the new bound port instead of conflict', async () => {
    const { result, applied, record } = await restart({
      mode: 'private', httpsPort: 443, boundPort: 3001, liveLocalPort: 3000,
      record: { httpsPort: 443, mode: 'private', localPort: 3000 },
    });
    expect(result.state).toBe('active');
    expect(result.url).toBe('https://mymachine.tailabc.ts.net');
    expect(applied).toEqual([
      ['tailscale', ...buildTailscaleServeArgs({ mode: 'private', httpsPort: 443, localPort: 3001 })],
    ]);
    expect(record).toEqual({ httpsPort: 443, mode: 'private', localPort: 3001 });
  });

  it('reports conflict when the live mapping points at neither the recorded nor the current port', async () => {
    const { result, applied, record } = await restart({
      mode: 'private', httpsPort: 443, boundPort: 3001, liveLocalPort: 4000,
      record: { httpsPort: 443, mode: 'private', localPort: 3000 },
    });
    expect(result.state).toBe('conflict');
    expect(result.errorCode).toBe('conflict');
    expect(applied).toEqual([]);
    expect(record).toEqual({ httpsPort: 443, mode: 'private', localPort: 3000 });
  });

  it('reports conflict when a stale live mapping has no record', async () => {
    const { result, applied, record } = await restart({
      mode: 'private', httpsPort: 443, boundPort: 3001, liveLocalPort: 3000, record: null,
    });
    expect(result.state).toBe('conflict');
    expect(result.errorCode).toBe('conflict');
    expect(applied).toEqual([]);
    expect(record).toBeNull();
  });

  it('repoints a record-owned funnel mapping to the new bound port', async () => {
    const { result, applied, record } = await restart({
      mode: 'public', httpsPort: 443, boundPort: 3001, liveLocalPort: 3000,
      record: { httpsPort: 443, mode: 'public', localPort: 3000 },
    });
    expect(result.state).toBe('active');
    expect(applied).toEqual([
      ['tailscale', ...buildTailscaleServeArgs({ mode: 'public', httpsPort: 443, localPort: 3001 })],
    ]);
    expect(applied[0][1]).toBe('funnel');
    expect(record).toEqual({ httpsPort: 443, mode: 'public', localPort: 3001 });
  });
});

describe('tailscale removal-failure handling (remove_failed)', () => {
  const mappingPath = '/data/tailscale-mapping.json';
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const liveWeb = (httpsPort, localPort) => JSON.stringify({
    Web: { [`mymachine.tailabc.ts.net:${httpsPort}`]: { Handlers: { '/': `http://127.0.0.1:${localPort}` } } },
  });
  // A failed `off` must not look like the "no handler" success case.
  const removalFailure = () => ({
    ok: false, code: 1, stdout: '', stderr: 'Error: tailscaled timed out removing the mapping', spawnError: null, timedOut: false,
  });
  const removalSuccess = () => ({ ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false });

  it('disabled + failed removal reports remove_failed, keeps the record, and retry clears it', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    let failRemoval = true;
    const removed = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return failRemoval ? removalFailure() : removalSuccess();
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: liveWeb(443, 3000), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.reconcile();
    expect(result.state).toBe('error');
    expect(result.errorCode).toBe('remove_failed');
    expect(result.url).toBeNull();
    expect(result.errorMessage).toContain('may still be reachable');
    expect(result.errorMessage).not.toContain('reset');
    // Host prerequisites still refresh on the error return.
    expect(result.installed).toBe(true);
    expect(result.loggedIn).toBe(true);
    // The record survives so retry can remove the still-live mapping.
    expect(memFs.has(mappingPath)).toBe(true);
    failRemoval = false;
    const retried = await service.retry();
    expect(retried.state).toBe('off');
    expect(retried.errorCode).toBeNull();
    expect(memFs.has(mappingPath)).toBe(false);
    expect(removed.length).toBe(2);
    service.dispose();
  });

  it('public-to-private switch with failed funnel removal applies nothing and keeps the old record', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set('/data/tailscale-config.json', JSON.stringify({ enabled: true, mode: 'private', httpsPort: 443 }));
    const oldRecord = { httpsPort: 8443, mode: 'public', localPort: 3000 };
    memFs.set(mappingPath, JSON.stringify(oldRecord));
    const applied = [];
    const removed = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return removalFailure();
          }
          if (args.includes('--bg')) {
            applied.push(args);
            return removalSuccess();
          }
          if (args[1] === 'funnel' && args.includes('status')) {
            return { ok: true, code: 0, stdout: liveWeb(8443, 3000), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.reconcile();
    expect(result.state).toBe('error');
    expect(result.errorCode).toBe('remove_failed');
    expect(result.errorMessage).toContain('Funnel');
    expect(result.errorMessage).toContain('8443');
    // The funnel removal was attempted, but no new serve mapping applied.
    expect(removed.some((args) => args[1] === 'funnel' && args.includes('off'))).toBe(true);
    expect(applied).toEqual([]);
    expect(JSON.parse(memFs.get(mappingPath))).toEqual(oldRecord);
    service.dispose();
  });

  it('blocked + failed removal reports remove_failed and keeps the record', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set('/data/tailscale-config.json', JSON.stringify({ enabled: true, mode: 'private', httpsPort: 443 }));
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => false,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) return removalFailure();
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: liveWeb(443, 3000), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    // A surviving mapping without auth must never be reported as blocked.
    const result = await service.reconcile();
    expect(result.state).toBe('error');
    expect(result.errorCode).toBe('remove_failed');
    expect(memFs.has(mappingPath)).toBe(true);
    service.dispose();
  });

  it('blocked + status query failure reports status_query_failed and keeps the record', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set('/data/tailscale-config.json', JSON.stringify({ enabled: true, mode: 'private', httpsPort: 443 }));
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    const removed = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => false,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return removalSuccess();
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: false, code: 1, stdout: '', stderr: 'boom', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: () => {},
    });
    await service.loadConfig();
    const result = await service.reconcile();
    expect(result.state).toBe('error');
    expect(result.errorCode).toBe('status_query_failed');
    expect(removed).toEqual([]);
    expect(memFs.has(mappingPath)).toBe(true);
    service.dispose();
  });

  it('shutdown with failed removal keeps the record and warns; success clears it', async () => {
    const { memFs, fsPromises } = memFsFor();
    memFs.set(mappingPath, JSON.stringify({ httpsPort: 443, mode: 'private', localPort: 3000 }));
    let failRemoval = true;
    const warnings = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) return failRemoval ? removalFailure() : removalSuccess();
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: liveWeb(443, 3000), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: (message) => warnings.push(String(message)),
    });
    await service.loadConfig();
    await service.shutdown();
    expect(memFs.has(mappingPath)).toBe(true);
    expect(warnings.some((message) => /leaving it for next-start cleanup/i.test(message))).toBe(true);
    service.dispose();

    failRemoval = false;
    warnings.length = 0;
    const retry = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) return removalSuccess();
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: liveWeb(443, 3000), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      logWarn: (message) => warnings.push(String(message)),
    });
    await retry.loadConfig();
    await retry.shutdown();
    expect(memFs.has(mappingPath)).toBe(false);
    retry.dispose();
  });
});

describe('tailscale config-response grace (slow apply)', () => {
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const waitFor = async (predicate, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() >= deadline) throw new Error('timed out waiting for background reconcile');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('setConfig returns transitional within the grace while the apply waits, then goes active', async () => {
    const { memFs, fsPromises } = memFsFor();
    let releaseApply;
    const applyGate = new Promise((resolve) => { releaseApply = resolve; });
    let service;
    service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      configResponseGraceMs: 20,
      runner: {
        runTailscale: (args, { onOutput } = {}) => {
          if (args.includes('serve') && args.includes('status')) {
            return Promise.resolve({ ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false });
          }
          if (args.includes('--bg')) {
            onOutput?.('visit https://login.tailscale.com/f/serve?node=n123 to approve\n');
            return applyGate.then(() => ({ ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false }));
          }
          return Promise.resolve({ ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false });
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: () => {},
    });
    await service.loadConfig();
    const startedAt = Date.now();
    const early = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    // Grace (20ms) elapses while the apply is still gated: quick,
    // transitional response for pollers to follow up on.
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(['starting', 'needs-approval']).toContain(early.state);
    releaseApply();
    await waitFor(() => service.getStatus().state === 'active');
    expect(service.getStatus().url).toBe('https://mymachine.tailabc.ts.net');
    expect(memFs.has('/data/tailscale-mapping.json')).toBe(true);
    service.dispose();
  });

  it('retry returns transitional within the grace while the apply waits, then goes active', async () => {
    const { fsPromises } = memFsFor();
    let releaseApply;
    const applyGate = new Promise((resolve) => { releaseApply = resolve; });
    let service;
    // Pre-existing enabled config (as if set before the approval wait).
    const seedFs = {
      readFile: fsPromises.readFile,
      writeFile: fsPromises.writeFile,
      mkdir: fsPromises.mkdir,
      rename: fsPromises.rename,
      unlink: fsPromises.unlink,
    };
    await seedFs.writeFile('/data/tailscale-config.json', JSON.stringify({ enabled: true, mode: 'private', httpsPort: 443 }));
    service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      configResponseGraceMs: 20,
      runner: {
        runTailscale: (args) => {
          if (args.includes('serve') && args.includes('status')) {
            return Promise.resolve({ ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false });
          }
          if (args.includes('--bg')) {
            return applyGate.then(() => ({ ok: true, code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false }));
          }
          return Promise.resolve({ ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false });
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: () => {},
    });
    await service.loadConfig();
    const early = await service.retry();
    expect(early.state).toBe('starting');
    releaseApply();
    await waitFor(() => service.getStatus().state === 'active');
    expect(service.getStatus().url).toBe('https://mymachine.tailabc.ts.net');
    service.dispose();
  });

  it('fast reconcile inside the grace returns the final status (disable -> off)', async () => {
    const { fsPromises } = memFsFor();
    let service;
    service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      configResponseGraceMs: 20,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: () => {},
    });
    await service.loadConfig();
    const enabled = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(enabled.state).toBe('active');
    const disabled = await service.setConfig({ enabled: false });
    expect(disabled.state).toBe('off');
    expect(disabled.errorCode).toBeNull();
    service.dispose();
  });

  it('a rejected background reconcile is logged and recorded as error/unknown without an unhandled rejection', async () => {
    const { fsPromises } = memFsFor();
    const warnings = [];
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let service;
    try {
      // Mapping-record writes throw; config persistence still succeeds so
      // setConfig kicks off reconcile and the failure lands in background.
      const failingFs = {
        ...fsPromises,
        writeFile: async (p, c) => {
          if (String(p).includes('tailscale-mapping')) throw new Error('disk full');
          return fsPromises.writeFile(p, c);
        },
      };
      service = createTailscaleService({
        existsSync: () => false,
        dataDir: '/data',
        getPort: () => 3000,
        isUiAuthEnabled: () => true,
        isUnsafeUnauthenticatedLanAllowed: () => false,
        configResponseGraceMs: 20,
        runner: {
          runTailscale: async (args) => {
            if (args.includes('serve') && args.includes('status')) {
              return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
            }
            return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
          },
        },
        fsPromises: failingFs,
        getServerId: async () => TEST_SERVER_ID,
        fetchImpl: matchingFetchImpl,
        logWarn: (message) => warnings.push(String(message)),
      });
      await service.loadConfig();
      const early = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      // The mapping-record write fails fast: the background settles inside
      // the grace, so the early response may already be the final error.
      expect(['starting', 'needs-approval', 'error']).toContain(early.state);
      await waitFor(() => service.getStatus().state === 'error');
      expect(service.getStatus().errorCode).toBe('unknown');
      expect(warnings.some((message) => /Background reconcile failed/i.test(message))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      service?.dispose();
    }
  });
});

describe('tailscale reconcile serialization (Off/Private overlap)', () => {
  const mappingPath = '/data/tailscale-mapping.json';
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const okResult = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', spawnError: null, timedOut: false });
  const oursWeb = (httpsPort, localPort) => JSON.stringify({
    Web: { [`mymachine.tailabc.ts.net:${httpsPort}`]: { Handlers: { '/': `http://127.0.0.1:${localPort}` } } },
  });
  const waitFor = async (predicate, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() >= deadline) throw new Error('timed out waiting for background reconcile');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('a superseded Off reconcile never removes the mapping the Private reconcile just verified', async () => {
    const { memFs, fsPromises } = memFsFor();
    const removed = [];
    // Armed after the initial enable: the next serve-status query blocks
    // until the test releases it, so the Off reconcile is stuck between
    // "query says ours" and "run off" while Private is requested.
    let blockServeStatus = false;
    let serveQueryStartedResolve = null;
    let releaseServeStatus = null;
    let serveGate = Promise.resolve();
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      configResponseGraceMs: 20,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('off')) {
            removed.push(args);
            return okResult();
          }
          if (args.includes('serve') && args.includes('status')) {
            if (blockServeStatus) {
              blockServeStatus = false;
              serveQueryStartedResolve?.();
              await serveGate;
            }
            return okResult(oursWeb(443, 3000));
          }
          return okResult(STATUS_JSON);
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: () => {},
    });
    await service.loadConfig();
    try {
      const enabled = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      expect(enabled.state).toBe('active');
      expect(memFs.has(mappingPath)).toBe(true);

      let startedResolve;
      const started = new Promise((resolve) => { startedResolve = resolve; });
      serveQueryStartedResolve = startedResolve;
      serveGate = new Promise((resolve) => { releaseServeStatus = resolve; });
      blockServeStatus = true;
      // Returns after the short grace while the Off reconcile is still
      // blocked in its serve-status query.
      const offResponse = await service.setConfig({ enabled: false });
      expect(offResponse).toBeDefined();
      await started;
      // Re-enable while the Off reconcile is in flight; with serialization
      // the Private reconcile queues behind it.
      const onResponse = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      expect(onResponse).toBeDefined();
      releaseServeStatus();

      await waitFor(() => service.getStatus().state === 'active');
      const final = service.getStatus();
      expect(final.state).toBe('active');
      expect(final.url).toBe('https://mymachine.tailabc.ts.net');
      // The superseded Off reconcile issued no removal and kept the
      // record the live Private mapping owns.
      expect(removed).toEqual([]);
      expect(memFs.has(mappingPath)).toBe(true);
    } finally {
      releaseServeStatus?.();
      service.dispose();
    }
  });

  it('two back-to-back retries never query serve status concurrently and skip the superseded one', async () => {
    const { fsPromises } = memFsFor();
    let inFlight = 0;
    let maxInFlight = 0;
    let serveStatusCount = 0;
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('serve') && args.includes('status')) {
            serveStatusCount += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              // Wide enough that overlapping reconciles would coincide.
              await new Promise((resolve) => setTimeout(resolve, 20));
              return okResult(oursWeb(443, 3000));
            } finally {
              inFlight -= 1;
            }
          }
          return okResult(STATUS_JSON);
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: () => {},
    });
    await service.loadConfig();
    try {
      const enabled = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      expect(enabled.state).toBe('active');
      serveStatusCount = 0;
      maxInFlight = 0;
      const [first, second] = await Promise.all([service.retry(), service.retry()]);
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(maxInFlight).toBeLessThanOrEqual(1);
      // The first retry was superseded while queued and skipped its work;
      // only the live retry queried serve status.
      expect(serveStatusCount).toBe(1);
      expect(service.getStatus().state).toBe('active');
    } finally {
      service.dispose();
    }
  });

  it('a reconcile whose body throws does not block the next reconcile', async () => {
    const { memFs, fsPromises } = memFsFor();
    const warnings = [];
    let failMappingWrite = true;
    const flakyFs = {
      ...fsPromises,
      writeFile: async (p, c) => {
        if (failMappingWrite && String(p).includes('tailscale-mapping')) throw new Error('disk full');
        return fsPromises.writeFile(p, c);
      },
    };
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('serve') && args.includes('status')) return okResult(JSON.stringify({ Web: {} }));
          return okResult(STATUS_JSON);
        },
      },
      fsPromises: flakyFs,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      logWarn: (message) => warnings.push(String(message)),
    });
    await service.loadConfig();
    try {
      const failed = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      expect(['starting', 'needs-approval', 'error']).toContain(failed.state);
      await waitFor(() => service.getStatus().state === 'error');
      expect(warnings.some((message) => /Background reconcile failed/i.test(message))).toBe(true);
      // The chain swallowed the failure: the next reconcile still runs.
      failMappingWrite = false;
      const retried = await service.retry();
      expect(retried.state).toBe('active');
      expect(retried.url).toBe('https://mymachine.tailabc.ts.net');
      expect(memFs.has(mappingPath)).toBe(true);
    } finally {
      service.dispose();
    }
  });
});

describe('tailscale tailnet-path probe fallback (nc)', () => {
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const createProbeService = ({ fetchImpl, tailnetHealthFetch }) => {
    const { fsPromises } = memFsFor();
    const fallbackCalls = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl,
      tailnetHealthFetch: async (args) => {
        fallbackCalls.push(args);
        return tailnetHealthFetch(args);
      },
      resolvePublicDns: async () => 'not-found',
      logWarn: () => {},
    });
    return { service, fallbackCalls };
  };
  const directDnsFailure = async () => {
    throw new Error('getaddrinfo ENOTFOUND mymachine.tailabc.ts.net');
  };

  it('goes active when the direct fetch throws but the tailnet path answers', async () => {
    const { service, fallbackCalls } = createProbeService({
      fetchImpl: directDnsFailure,
      tailnetHealthFetch: async () => ({ ok: true, status: 200, body: { serverId: TEST_SERVER_ID } }),
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('active');
    expect(result.url).toBe('https://mymachine.tailabc.ts.net');
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]).toMatchObject({ host: 'mymachine.tailabc.ts.net', port: 443 });
    service.dispose();
  });

  it('stays starting when the tailnet path reports a different server', async () => {
    const { service, fallbackCalls } = createProbeService({
      fetchImpl: directDnsFailure,
      tailnetHealthFetch: async () => ({ ok: true, status: 200, body: { serverId: 'some-other-server' } }),
    });
    await service.loadConfig();
    const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(result.state).toBe('starting');
    expect(result.url).toBeNull();
    expect(fallbackCalls).toHaveLength(1);
    service.dispose();
  });

  it('never uses the tailnet path when the direct path answers', async () => {
    // Non-OK direct response.
    const nonOk = createProbeService({
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
      tailnetHealthFetch: async () => ({ ok: true, status: 200, body: { serverId: TEST_SERVER_ID } }),
    });
    await nonOk.service.loadConfig();
    const nonOkResult = await nonOk.service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(nonOkResult.state).toBe('starting');
    expect(nonOkResult.url).toBeNull();
    expect(nonOk.fallbackCalls).toEqual([]);
    nonOk.service.dispose();
    // Mismatching serverId direct response.
    const mismatch = createProbeService({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ serverId: 'some-other-server' }) }),
      tailnetHealthFetch: async () => ({ ok: true, status: 200, body: { serverId: TEST_SERVER_ID } }),
    });
    await mismatch.service.loadConfig();
    const mismatchResult = await mismatch.service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
    expect(mismatchResult.state).toBe('starting');
    expect(mismatchResult.url).toBeNull();
    expect(mismatch.fallbackCalls).toEqual([]);
    mismatch.service.dispose();
  });

  it('stays starting when the tailnet path fails, without an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const services = [];
    try {
      // Throwing fallback.
      const throwing = createProbeService({
        fetchImpl: directDnsFailure,
        tailnetHealthFetch: async () => { throw new Error('nc exploded'); },
      });
      services.push(throwing.service);
      await throwing.service.loadConfig();
      const throwingResult = await throwing.service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      expect(throwingResult.state).toBe('starting');
      expect(throwingResult.url).toBeNull();
      expect(throwing.fallbackCalls).toHaveLength(1);
      // Failing (non-throwing) fallback.
      const failing = createProbeService({
        fetchImpl: directDnsFailure,
        tailnetHealthFetch: async () => ({ ok: false, status: null, body: null, error: 'timeout' }),
      });
      services.push(failing.service);
      await failing.service.loadConfig();
      const failingResult = await failing.service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      expect(failingResult.state).toBe('starting');
      expect(failingResult.url).toBeNull();
      expect(failing.fallbackCalls).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      for (const service of services) service.dispose();
    }
  });
});

describe('tailscale nc health fetch', () => {
  it('reports a spawn failure instead of throwing', async () => {
    const fetch = createTailscaleNcHealthFetch({
      executable: 'tailscale',
      spawnFn: () => { throw new Error('spawn tailscale ENOENT'); },
    });
    const result = await fetch({ host: 'mymachine.tailabc.ts.net', port: 443, timeoutMs: 100 });
    expect(result).toEqual({ ok: false, status: null, body: null, error: 'spawn' });
  });

  it('rejects an invalid target without spawning', async () => {
    const spawnFn = vi.fn();
    const fetch = createTailscaleNcHealthFetch({ executable: 'tailscale', spawnFn });
    const result = await fetch({ host: '', port: 443, timeoutMs: 100 });
    expect(result).toEqual({ ok: false, status: null, body: null, error: 'invalid-target' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('kills the child when the probe times out', async () => {
    const { PassThrough } = await import('node:stream');
    const { EventEmitter } = await import('node:events');
    const children = [];
    const spawnFn = (command, args, options) => {
      expect(command).toBe('tailscale');
      expect(args).toEqual(['nc', 'mymachine.tailabc.ts.net', '443']);
      expect(options).toMatchObject({ windowsHide: true, shell: false });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();
      child.stdout.on('error', () => {});
      child.stdin.on('error', () => {});
      children.push(child);
      return child;
    };
    const fetch = createTailscaleNcHealthFetch({ executable: 'tailscale', spawnFn });
    // No handshake bytes ever arrive, so the probe must time out.
    const result = await fetch({ host: 'mymachine.tailabc.ts.net', port: 443, timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    children[0].stdout.destroy();
    children[0].stdin.destroy();
  });

  it('aborts on signal and kills the child', async () => {
    const { PassThrough } = await import('node:stream');
    const { EventEmitter } = await import('node:events');
    const children = [];
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();
      child.stdout.on('error', () => {});
      child.stdin.on('error', () => {});
      children.push(child);
      return child;
    };
    const fetch = createTailscaleNcHealthFetch({ executable: 'tailscale', spawnFn });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await fetch({
      host: 'mymachine.tailabc.ts.net',
      port: 443,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, status: null, body: null, error: 'aborted' });
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    children[0].stdout.destroy();
    children[0].stdin.destroy();
  });
});

describe('tailscale public DNS readiness (funnel)', () => {
  const memFsFor = () => {
    const memFs = new Map();
    return {
      memFs,
      fsPromises: {
        readFile: async (p) => {
          if (!memFs.has(p)) { const e = new Error('x'); e.code = 'ENOENT'; throw e; }
          return memFs.get(p);
        },
        writeFile: async (p, c) => { memFs.set(p, String(c)); },
        mkdir: async () => {},
        rename: async (a, b) => { memFs.set(b, memFs.get(a)); memFs.delete(a); },
        unlink: async (p) => { memFs.delete(p); },
      },
    };
  };
  const flush = async (rounds = 5) => {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const createPublicService = ({ dnsImpl, mode = 'public' } = {}) => {
    const { fsPromises } = memFsFor();
    const dnsCalls = [];
    const resolvePublicDns = async (hostname) => {
      dnsCalls.push(hostname);
      return dnsImpl(hostname);
    };
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          const sub = mode === 'public' ? 'funnel' : 'serve';
          if (args.includes(sub) && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('funnel') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      resolvePublicDns,
      logWarn: () => {},
    });
    return { service, dnsCalls };
  };

  it('public active pending -> ready via interval with fake timers, then stops polling', async () => {
    vi.useFakeTimers();
    let dnsResult = 'not-found';
    const { service, dnsCalls } = createPublicService({ dnsImpl: async () => dnsResult });
    try {
      await service.loadConfig();
      const result = await service.setConfig({ enabled: true, mode: 'public', httpsPort: 443 });
      expect(result.state).toBe('active');
      // Immediate check runs async: flush it.
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus().publicDns).toBe('pending');
      expect(dnsCalls.length).toBe(1);
      // Still not found after one interval.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.getStatus().publicDns).toBe('pending');
      expect(dnsCalls.length).toBe(2);
      // Record appears: next interval flips to ready and stops.
      dnsResult = 'found';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.getStatus().publicDns).toBe('ready');
      const callsAtReady = dnsCalls.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(dnsCalls.length).toBe(callsAtReady);
      expect(service.getStatus().publicDns).toBe('ready');
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it('error maps to unknown and recovers to pending then ready', async () => {
    vi.useFakeTimers();
    let dnsResult = 'error';
    const { service, dnsCalls } = createPublicService({ dnsImpl: async () => dnsResult });
    try {
      await service.loadConfig();
      await service.setConfig({ enabled: true, mode: 'public', httpsPort: 443 });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus().publicDns).toBe('unknown');
      dnsResult = 'not-found';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.getStatus().publicDns).toBe('pending');
      dnsResult = 'found';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.getStatus().publicDns).toBe('ready');
      expect(dnsCalls.length).toBeGreaterThanOrEqual(3);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it('private active never queries DNS and reports null', async () => {
    const { service, dnsCalls } = createPublicService({ dnsImpl: async () => 'found', mode: 'private' });
    try {
      await service.loadConfig();
      const result = await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      expect(result.state).toBe('active');
      expect(result.publicDns).toBeNull();
      await flush();
      expect(dnsCalls).toEqual([]);
      expect(service.getStatus().publicDns).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it('non-active states report null (off)', async () => {
    const { service } = createHarness({
      handlers: {
        'status --json': { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false },
      },
    });
    try {
      await service.loadConfig();
      expect(service.getStatus().publicDns).toBeNull();
      const off = await service.reconcile();
      expect(off.state).toBe('off');
      expect(off.publicDns).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it('mode switch public->private stops the watcher and reports null', async () => {
    vi.useFakeTimers();
    let dnsResult = 'not-found';
    const { service, dnsCalls } = createPublicService({ dnsImpl: async () => dnsResult });
    try {
      await service.loadConfig();
      await service.setConfig({ enabled: true, mode: 'public', httpsPort: 443 });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus().publicDns).toBe('pending');
      const callsBefore = dnsCalls.length;
      await service.setConfig({ enabled: true, mode: 'private', httpsPort: 443 });
      expect(service.getStatus().publicDns).toBeNull();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(dnsCalls.length).toBe(callsBefore);
      expect(service.getStatus().publicDns).toBeNull();
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it('disable stops the watcher; a stale resolve never writes after the generation bump', async () => {
    let releaseDns = null;
    const gate = new Promise((resolve) => { releaseDns = resolve; });
    const { fsPromises } = memFsFor();
    const dnsCalls = [];
    const service = createTailscaleService({
      existsSync: () => false,
      dataDir: '/data',
      getPort: () => 3000,
      isUiAuthEnabled: () => true,
      isUnsafeUnauthenticatedLanAllowed: () => false,
      runner: {
        runTailscale: async (args) => {
          if (args.includes('funnel') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          if (args.includes('serve') && args.includes('status')) {
            return { ok: true, code: 0, stdout: JSON.stringify({ Web: {} }), stderr: '', spawnError: null, timedOut: false };
          }
          return { ok: true, code: 0, stdout: STATUS_JSON, stderr: '', spawnError: null, timedOut: false };
        },
      },
      fsPromises,
      getServerId: async () => TEST_SERVER_ID,
      fetchImpl: matchingFetchImpl,
      resolvePublicDns: async (hostname) => {
        dnsCalls.push(hostname);
        await gate;
        return 'found';
      },
      logWarn: () => {},
    });
    try {
      await service.loadConfig();
      const active = await service.setConfig({ enabled: true, mode: 'public', httpsPort: 443 });
      expect(active.state).toBe('active');
      expect(active.publicDns).toBe('pending');
      // Bump the generation while the immediate DNS check is in flight.
      const disabled = await service.setConfig({ enabled: false });
      expect(disabled.state).toBe('off');
      expect(disabled.publicDns).toBeNull();
      // Late DNS success must not resurrect publicDns.
      releaseDns();
      await flush(10);
      expect(service.getStatus().state).toBe('off');
      expect(service.getStatus().publicDns).toBeNull();
    } finally {
      try { releaseDns?.(); } catch {}
      service.dispose();
    }
  });

  it('shutdown stops the watcher: no further resolver calls', async () => {
    vi.useFakeTimers();
    let dnsResult = 'not-found';
    const { service, dnsCalls } = createPublicService({ dnsImpl: async () => dnsResult });
    try {
      await service.loadConfig();
      await service.setConfig({ enabled: true, mode: 'public', httpsPort: 443 });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus().publicDns).toBe('pending');
      const callsBefore = dnsCalls.length;
      await service.shutdown();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(dnsCalls.length).toBe(callsBefore);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it('interval backs off to 2 minutes after 20 minutes', async () => {
    vi.useFakeTimers();
    const { service, dnsCalls } = createPublicService({ dnsImpl: async () => 'not-found' });
    try {
      await service.loadConfig();
      await service.setConfig({ enabled: true, mode: 'public', httpsPort: 443 });
      await vi.advanceTimersByTimeAsync(0);
      expect(dnsCalls.length).toBe(1);
      // 30s cadence for the first 20 minutes: 40 intervals reach t=20min.
      for (let i = 0; i < 40; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const callsAt20min = dnsCalls.length;
      expect(callsAt20min).toBe(1 + 40);
      // After 20 minutes the cadence is 2 minutes: +30s is not enough.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(dnsCalls.length).toBe(callsAt20min);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(dnsCalls.length).toBe(callsAt20min + 1);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });
});

describe('public-dns resolver mapping', () => {
  it('maps answers, NXDOMAIN/NODATA, and failures without touching the network', async () => {
    const { createResolvePublicDns } = await import('./public-dns.js');
    const scripted = ({ v4, v6 }) => {
      const calls = [];
      const resolve = createResolvePublicDns({
        createResolver: () => ({
          setServers: () => {},
          cancel: () => {},
          resolve4: async () => {
            calls.push('v4');
            if (v4 instanceof Error) throw v4;
            return v4;
          },
          resolve6: async () => {
            calls.push('v6');
            if (v6 instanceof Error) throw v6;
            return v6;
          },
        }),
      });
      return { resolve, calls };
    };
    const notFound4 = Object.assign(new Error('queryA ENOTFOUND m.ts.net'), { code: 'ENOTFOUND' });
    const noData6 = Object.assign(new Error('queryAaaa ENODATA m.ts.net'), { code: 'ENODATA' });
    // Any address -> found.
    {
      const { resolve: resolveFound } = scripted({ v4: ['93.184.216.34'], v6: noData6 });
      expect(await resolveFound('m.ts.net')).toBe('found');
    }
    // All NXDOMAIN/NODATA -> not-found.
    {
      const { resolve: resolveNotFound } = scripted({ v4: notFound4, v6: noData6 });
      expect(await resolveNotFound('m.ts.net')).toBe('not-found');
    }
    // Timeout/refused -> error.
    {
      const timeout = Object.assign(new Error('queryA ETIMEOUT m.ts.net'), { code: 'ETIMEOUT' });
      const { resolve: resolveError } = scripted({ v4: timeout, v6: noData6 });
      expect(await resolveError('m.ts.net')).toBe('error');
    }
    // Never throws on bad input.
    {
      const { resolve: resolveBad } = scripted({ v4: ['1.1.1.1'], v6: ['::1'] });
      expect(await resolveBad('')).toBe('error');
      expect(await resolveBad(null)).toBe('error');
    }
  });
});
