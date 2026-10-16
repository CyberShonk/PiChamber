import { describe, expect, test } from 'bun:test';
import { DESKTOP_HOST_HEALTH_PIN_TIMEOUT_MS, desktopHostProbe, desktopHostsGet, desktopHostsSet, importDesktopHostPairing, redactSensitiveUrl, resolveDesktopHostUrl, withEditedDesktopHostUrl, type DesktopHost } from './desktopHosts';
import { buildPairingConnectionPayload, encodePairingConnectionPayload, type PairingEndpointCandidate } from './connectionPayload';

const withDesktopBridge = async <T>(handler: (cmd: string, args: Record<string, unknown>) => unknown | Promise<unknown>, run: () => Promise<T>): Promise<T> => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __PICHAMBER_DESKTOP__: {
        invoke: handler,
      },
    },
  });
  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('resolveDesktopHostUrl', () => {
  test('keeps regular host URLs unchanged', () => {
    expect(resolveDesktopHostUrl('https://example.com/app?x=1')).toEqual({
      persistedUrl: 'https://example.com/app?x=1',
      redeemUrl: null,
      kind: 'normal-host',
    });
  });

  test('detects tunnel connect links and stores only origin', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect?t=secret-token')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('detects tunnel connect links with trailing slash', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect/?t=secret-token#section')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect/?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('redacts tunnel tokens from labels', () => {
    expect(redactSensitiveUrl('https://example.trycloudflare.com/connect?t=secret-token')).toBe(
      'https://example.trycloudflare.com/connect?t=%5BREDACTED%5D',
    );
  });
});

describe('importDesktopHostPairing', () => {
  test('rejects malformed pairing links before changing hosts', async () => {
    await expect(importDesktopHostPairing('not-a-connect-link', [])).rejects.toThrow('invalid-connect-link');
  });

  test('pin read defaults to a 5s timeout', () => {
    expect(DESKTOP_HOST_HEALTH_PIN_TIMEOUT_MS).toBe(5_000);
  });
});

describe('importDesktopHostPairing dedup and pin timeout', () => {
  const TEST_JWK: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'test-x', y: 'test-y' };

  const pairingLink = (candidates: PairingEndpointCandidate[]): string =>
    encodePairingConnectionPayload(
      buildPairingConnectionPayload({
        pairingId: 'pair-1',
        secret: 'secret-1',
        candidates,
      }),
    );

  type FetchStub = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>;

  const urlOf = (input: Parameters<typeof fetch>[0]): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  const withFetchStub = async <T>(stub: FetchStub, run: () => Promise<T>): Promise<T> => {
    const previous = globalThis.fetch;
    globalThis.fetch = stub as typeof globalThis.fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = previous;
    }
  };

  // Routes pairing-redeem to a fresh token and /health to a canned identity.
  // `health: 'hang'` never resolves until its abort signal fires; `health:
  // 'fail'` answers 500 (unpinned, old behavior).
  const pairingFetchStub = (health: { serverId: string } | 'hang' | 'fail'): FetchStub =>
    async (input, init) => {
      const raw = urlOf(input);
      if (raw.endsWith('/api/client-auth/pairing/redeem')) {
        return new Response(JSON.stringify({ clientToken: 'tok-fresh' }), { status: 200 });
      }
      if (raw.endsWith('/health')) {
        if (health === 'hang') {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
              return;
            }
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('The operation was aborted.', 'AbortError')),
              { once: true },
            );
          });
        }
        if (health === 'fail') return new Response('nope', { status: 500 });
        return new Response(JSON.stringify({ serverId: health.serverId }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${raw}`);
    };

  test('re-pair over a different direct URL updates the pinned row', async () => {
    const lan = 'http://192.168.1.10:3000';
    const tail = 'https://box.tailxyz.ts.net';
    const existing: DesktopHost[] = [{
      id: 'h1',
      label: 'LAN Server',
      url: lan,
      apiUrl: lan,
      clientToken: 'tok-old',
      serverId: 'srv-123',
    }];
    await withFetchStub(pairingFetchStub({ serverId: 'srv-123' }), async () => {
      const { hosts, hostId } = await importDesktopHostPairing(
        pairingLink([{ type: 'tailscale', url: tail }]),
        existing,
      );
      expect(hostId).toBe('h1');
      expect(hosts).toHaveLength(1);
      expect(hosts[0]).toMatchObject({
        id: 'h1',
        label: 'LAN Server',
        url: tail,
        apiUrl: tail,
        clientToken: 'tok-fresh',
        serverId: 'srv-123',
      });
    });
  });

  test('a URL match with a conflicting pinned serverId creates a new row', async () => {
    const direct = 'http://box:3000';
    const existing: DesktopHost[] = [{
      id: 'h1',
      label: 'Old',
      url: direct,
      apiUrl: direct,
      clientToken: 'tok-old',
      serverId: 'srv-old',
    }];
    await withFetchStub(pairingFetchStub({ serverId: 'srv-new' }), async () => {
      const { hosts, hostId } = await importDesktopHostPairing(
        pairingLink([{ type: 'lan', url: direct }]),
        existing,
      );
      expect(hosts).toHaveLength(2);
      expect(hostId).not.toBe('h1');
      expect(hosts.find((host) => host.id === 'h1')).toMatchObject({
        clientToken: 'tok-old',
        serverId: 'srv-old',
      });
      expect(hosts.find((host) => host.id === hostId)).toMatchObject({
        apiUrl: direct,
        clientToken: 'tok-fresh',
        serverId: 'srv-new',
      });
    });
  });

  test('a hanging /health read does not hang the import', async () => {
    let healthInit: RequestInit | undefined;
    const stub: FetchStub = async (input, init) => {
      const raw = urlOf(input);
      if (raw.endsWith('/api/client-auth/pairing/redeem')) {
        return new Response(JSON.stringify({ clientToken: 'tok-fresh' }), { status: 200 });
      }
      if (raw.endsWith('/health')) {
        healthInit = init;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        });
      }
      throw new Error(`unexpected fetch: ${raw}`);
    };
    const started = Date.now();
    await withFetchStub(stub, async () => {
      const { hosts, hostId } = await importDesktopHostPairing(
        pairingLink([{ type: 'lan', url: 'http://blackhole:3000' }]),
        [],
        { healthTimeoutMs: 20 },
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(hosts).toHaveLength(1);
      expect(hosts[0]?.id).toBe(hostId);
      // Timed-out pin read leaves the record unpinned (best-effort).
      expect(hosts[0]?.serverId).toBeUndefined();
      expect(hosts[0]?.clientToken).toBe('tok-fresh');
    });
    // The pin read is wired to an abort signal and sends no credentials.
    expect(healthInit?.signal).toBeDefined();
    expect(healthInit?.signal?.aborted).toBe(true);
    expect(healthInit?.credentials).toBe('omit');
  });

  test('same-URL re-pair updates the existing row', async () => {
    const direct = 'http://box:3000';
    const existing: DesktopHost[] = [{
      id: 'h1',
      label: 'Box',
      url: direct,
      apiUrl: direct,
      clientToken: 'tok-old',
      serverId: 'srv-1',
    }];
    await withFetchStub(pairingFetchStub({ serverId: 'srv-1' }), async () => {
      const { hosts, hostId } = await importDesktopHostPairing(
        pairingLink([{ type: 'lan', url: direct }]),
        existing,
      );
      expect(hostId).toBe('h1');
      expect(hosts).toHaveLength(1);
      expect(hosts[0]).toMatchObject({
        id: 'h1',
        label: 'Box',
        apiUrl: direct,
        clientToken: 'tok-fresh',
        serverId: 'srv-1',
      });
    });
  });

  test('relay serverId match still updates the existing row', async () => {
    const direct = 'http://box:3000';
    const existing: DesktopHost[] = [{
      id: 'h-relay',
      label: 'Relayed',
      url: 'relay://srv-relay',
      relay: { relayUrl: 'wss://relay.example/ws', serverId: 'srv-relay', hostEncPubJwk: TEST_JWK },
      clientToken: 'tok-old',
    }];
    // Redeem succeeds over direct (direct candidates sort first, so no
    // tunnel is opened), but the relay candidate pins the row by serverId
    // even though /health reports nothing.
    await withFetchStub(pairingFetchStub('fail'), async () => {
      const { hosts, hostId } = await importDesktopHostPairing(
        pairingLink([
          { type: 'lan', url: direct },
          { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv-relay', hostEncPubJwk: TEST_JWK },
        ]),
        existing,
      );
      expect(hostId).toBe('h-relay');
      expect(hosts).toHaveLength(1);
      expect(hosts[0]).toMatchObject({
        id: 'h-relay',
        label: 'Relayed',
        apiUrl: direct,
        clientToken: 'tok-fresh',
        relay: { relayUrl: 'wss://relay.example/ws', serverId: 'srv-relay' },
      });
    });
  });
});

describe('desktop host runtime headers', () => {
  test('parses persisted request headers from desktop config', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [{
          id: 'remote-1',
          label: 'Remote',
          url: 'https://remote.example',
          requestHeaders: {
            ' CF-Access-Client-Id ': ' client-id ',
            Authorization: 'Bearer should-not-be-read',
            'Bad:Name': 'bad',
          },
        }],
        defaultHostId: 'remote-1',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(config.hosts[0]?.requestHeaders).toEqual({
        'CF-Access-Client-Id': 'client-id',
      });
    });
  });

  test('passes request headers through host save and probe IPC calls', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    await withDesktopBridge(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'desktop_host_probe') return { status: 'ok', latencyMs: 7 };
      return null;
    }, async () => {
      const requestHeaders = { 'CF-Access-Client-Id': 'client-id' };
      await desktopHostsSet({
        hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders }],
        defaultHostId: 'remote-1',
      });
      const probe = await desktopHostProbe('https://remote.example', { requestHeaders });
      expect(probe).toEqual({ status: 'ok', latencyMs: 7 });
    });

    expect(calls[0]).toEqual({
      cmd: 'desktop_hosts_set',
      args: {
        input: {
          hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders: { 'CF-Access-Client-Id': 'client-id' } }],
          defaultHostId: 'remote-1',
          initialHostChoiceCompleted: undefined,
        },
      },
    });
    expect(calls[1]).toEqual({
      cmd: 'desktop_host_probe',
      args: {
        url: 'https://remote.example',
        requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
      },
    });
  });
});

describe('withEditedDesktopHostUrl', () => {
  const host = { id: 'h1', label: 'Old', url: 'http://old-box:3000', apiUrl: 'http://old-box:3000', serverId: 'old-id' };

  test('drops the pinned serverId when the address changes', () => {
    const next = withEditedDesktopHostUrl(host, 'https://new-box.tail.ts.net');
    expect(next.url).toBe('https://new-box.tail.ts.net');
    expect(next.apiUrl).toBe('https://new-box.tail.ts.net');
    expect('serverId' in next).toBe(false);
    expect(host.serverId).toBe('old-id');
  });

  test('keeps the pinned serverId when only other fields are edited', () => {
    const next = withEditedDesktopHostUrl(host, 'http://old-box:3000');
    expect(next.serverId).toBe('old-id');
  });
});
