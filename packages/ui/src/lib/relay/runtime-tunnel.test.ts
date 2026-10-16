import { afterEach, describe, expect, test } from 'bun:test';
import {
  adoptRelayTunnel,
  deactivateRelayTunnel,
  isRelayModeActive,
  subscribeRelayMode,
  type RelayRuntimeDescriptor,
} from './runtime-tunnel';
import type { RelayTunnelClient } from './tunnel-client';

const descriptor: RelayRuntimeDescriptor = {
  relayUrl: 'wss://relay.example.test',
  serverId: 'server-1',
  hostEncPubJwk: { kty: 'EC' },
};

const fakeClient = (): RelayTunnelClient & { closed: number } => {
  const client = { closed: 0, close() { client.closed += 1; } };
  return client as unknown as RelayTunnelClient & { closed: number };
};

afterEach(() => {
  deactivateRelayTunnel();
});

describe('relay mode subscription', () => {
  test('notifies only when relay mode flips', () => {
    let calls = 0;
    const unsubscribe = subscribeRelayMode(() => { calls += 1; });

    adoptRelayTunnel(descriptor, fakeClient());
    expect(isRelayModeActive()).toBe(true);
    expect(calls).toBe(1);

    // Replacing one live tunnel with another keeps relay mode on: no notify.
    const second = fakeClient();
    adoptRelayTunnel(descriptor, second);
    expect(calls).toBe(1);

    deactivateRelayTunnel();
    expect(isRelayModeActive()).toBe(false);
    expect(second.closed).toBe(1);
    expect(calls).toBe(2);

    // Already off: no notify.
    deactivateRelayTunnel();
    expect(calls).toBe(2);

    unsubscribe();
    adoptRelayTunnel(descriptor, fakeClient());
    expect(calls).toBe(2);
  });
});
