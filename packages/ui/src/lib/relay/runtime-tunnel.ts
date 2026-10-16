// Module-level singleton holding the active relay tunnel client, if the runtime
// is in relay mode. Kept in its own module so runtime-switch, runtime-fetch,
// runtime-url, and the event pipeline can all read it without an import cycle
// (runtime-switch <-> runtime-url).

import { createRelayTunnelClient, type RelayTunnelClient } from './tunnel-client';

export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
}

let activeTunnel: RelayTunnelClient | null = null;
let activeDescriptor: RelayRuntimeDescriptor | null = null;

const descriptorsEqual = (a: RelayRuntimeDescriptor, b: RelayRuntimeDescriptor): boolean =>
  a.relayUrl === b.relayUrl &&
  a.serverId === b.serverId &&
  a.grant === b.grant &&
  JSON.stringify(a.hostEncPubJwk) === JSON.stringify(b.hostEncPubJwk);

export const getActiveRelayTunnel = (): RelayTunnelClient | null => activeTunnel;
export const getActiveRelayDescriptor = (): Omit<RelayRuntimeDescriptor, 'grant'> | null => {
  if (!activeTunnel || !activeDescriptor) return null;
  return {
    relayUrl: activeDescriptor.relayUrl,
    serverId: activeDescriptor.serverId,
    hostEncPubJwk: { ...activeDescriptor.hostEncPubJwk },
  };
};

export const isRelayModeActive = (): boolean => activeTunnel !== null;

// Render-time readers (e.g. the mobile server list's Direct/Relay label)
// subscribe here so a tunnel opening or closing re-renders them instead of
// leaving a stale snapshot. Notified only when relay mode flips.
const relayModeListeners = new Set<() => void>();

export const subscribeRelayMode = (listener: () => void): (() => void) => {
  relayModeListeners.add(listener);
  return () => {
    relayModeListeners.delete(listener);
  };
};

const notifyRelayModeChange = (wasActive: boolean): void => {
  if (wasActive === isRelayModeActive()) return;
  for (const listener of [...relayModeListeners]) listener();
};

/**
 * Activates relay mode with the given descriptor, replacing any previous tunnel.
 * Reuses the existing client when the descriptor is unchanged so a redundant
 * runtime switch does not tear down a live tunnel.
 */
export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => {
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
    return activeTunnel;
  }
  const wasActive = isRelayModeActive();
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeTunnel = createRelayTunnelClient(descriptor);
  notifyRelayModeChange(wasActive);
  return activeTunnel;
};

/**
 * Adopts an ALREADY-OPEN tunnel client (e.g. the connect flow's probe tunnel)
 * as the active runtime tunnel, so the immediately following
 * `activateRelayTunnel` with an equal descriptor reuses it instead of paying a
 * second WebSocket connect + E2EE handshake. Replaces any previous tunnel.
 */
export const adoptRelayTunnel = (descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  if (activeTunnel === client) return;
  const wasActive = isRelayModeActive();
  activeTunnel?.close();
  activeDescriptor = descriptor;
  activeTunnel = client;
  notifyRelayModeChange(wasActive);
};

export const deactivateRelayTunnel = (): void => {
  const wasActive = isRelayModeActive();
  activeTunnel?.close();
  activeTunnel = null;
  activeDescriptor = null;
  notifyRelayModeChange(wasActive);
};
