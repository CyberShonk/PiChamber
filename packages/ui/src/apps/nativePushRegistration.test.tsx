import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let runtimeKey = 'host-a';
let notificationEnabled = true;
let permission: 'granted' | 'denied' | 'prompt' = 'granted';
let permissionRequests = 0;
let deviceRegistrations = 0;
let deviceUnregistrations = 0;
const endpointListeners = new Set<() => void>();
const listeners = new Map<string, Set<(value: { value?: string; error?: string }) => void>>();
const serverRegistrations: Array<{ runtimeKey: string; token: string }> = [];
const serverUnregistrations: string[] = [];
let serverResponse: () => Promise<{ ok: true } | null> = async () => ({ ok: true });

mock.module('@/stores/useUIStore', () => ({ useUIStore: (selector: (state: { nativeNotificationsEnabled: boolean }) => unknown) => selector({ nativeNotificationsEnabled: notificationEnabled }) }));
mock.module('@/lib/platform', () => ({ getClientPlatform: () => 'ios' }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpointListeners.add(listener); return () => endpointListeners.delete(listener); },
}));
mock.module('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => ({ push: {
  registerApnsToken: async ({ token }: { token: string }) => { serverRegistrations.push({ runtimeKey, token }); return serverResponse(); },
  unregisterApnsToken: async () => { serverUnregistrations.push(runtimeKey); return { ok: true }; },
} }) }));
mock.module('@capacitor/push-notifications', () => ({ PushNotifications: {
  checkPermissions: async () => ({ receive: permission }),
  requestPermissions: async () => { permissionRequests++; return { receive: 'granted' }; },
  addListener: async (name: string, callback: (value: { value?: string; error?: string }) => void) => {
    const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(callback);
    return { remove: async () => { set.delete(callback); } };
  },
  register: async () => { deviceRegistrations++; },
  unregister: async () => { deviceUnregistrations++; },
} }));
const { useNativePushRegistration } = await import('./useNativePushRegistration');
const { useNativePushStatus } = await import('./native/pushStatus');
let status: ReturnType<typeof useNativePushStatus>;
const Harness = () => { useNativePushRegistration({ enabled: true }); status = useNativePushStatus(); return null; };
const noop = () => undefined;

const installDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentEvents = new EventTarget();
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    visibilityState: 'visible',
  };
  const makeNode = (tagName = 'div') => {
    const node: Record<string, unknown> = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      nodeName: tagName.toUpperCase(),
      ownerDocument: documentStub,
      parentNode: null,
      childNodes: [],
      children: [],
      style: {
        getPropertyValue: () => '',
        getPropertyPriority: () => '',
        setProperty: noop,
        removeProperty: noop,
      },
      classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
      setAttribute: noop,
      getAttribute: () => null,
      hasAttribute: () => false,
      addEventListener: noop,
      removeEventListener: noop,
      focus: noop,
      blur: noop,
      contains: () => false,
      textContent: '',
    };
    node.appendChild = (child: Record<string, unknown>) => {
      (node.childNodes as unknown[]).push(child);
      (node.children as unknown[]).push(child);
      if (child && typeof child === 'object') {
        child.parentNode = node;
      }
      return child;
    };
    node.insertBefore = (child: Record<string, unknown>) => (node.appendChild as (c: unknown) => unknown)(child);
    node.removeChild = (child: Record<string, unknown>) => {
      const list = node.childNodes as unknown[];
      const idx = list.indexOf(child);
      if (idx !== -1) list.splice(idx, 1);
      const clist = node.children as unknown[];
      const cidx = clist.indexOf(child);
      if (cidx !== -1) clist.splice(cidx, 1);
      if (child && typeof child === 'object') {
        child.parentNode = null;
      }
      return child;
    };
    return node;
  };
  documentStub.createElement = makeNode;
  documentStub.createElementNS = (_ns: string, tag: string) => makeNode(tag);
  documentStub.createTextNode = (text: string) => ({ nodeType: 3, nodeName: '#text', textContent: text, parentNode: null });
  documentStub.getElementById = () => null;
  const container = makeNode('div');
  documentStub.documentElement = container;
  documentStub.body = container;
  documentStub.defaultView = globalThis;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('navigator', { userAgent: 'test', onLine: true });
  setGlobal('location', { search: '', protocol: 'capacitor:', hostname: 'localhost', origin: 'capacitor://localhost', href: 'capacitor://localhost/' });
  setGlobal('matchMedia', () => ({ matches: false, addEventListener: noop, removeEventListener: noop }));
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  class MutationObserverStub {
    observe = noop;
    disconnect = noop;
    takeRecords = () => [];
  }
  setGlobal('MutationObserver', MutationObserverStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
  return {
    container: container as unknown as Element,
    setVisibility: (state: 'hidden' | 'visible') => {
      documentStub.visibilityState = state;
      documentEvents.dispatchEvent(new Event('visibilitychange'));
    },
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

let root: Root | null = null;
let restore: (() => void) | null = null;
const flush = async () => { for (let index = 0; index < 6; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const mount = async () => {
  const dom = installDom(); restore = dom.restore;
  root = createRoot(dom.container as unknown as HTMLElement);
  await act(async () => { root!.render(<Harness />); });
  await flush();
};
const emitToken = async () => { await act(async () => { listeners.get('registration')?.forEach((listener) => listener({ value: 'test-device-token' })); }); await flush(); };
const switchHost = async (key: string) => { await act(async () => { runtimeKey = key; endpointListeners.forEach((listener) => listener()); }); await flush(); };

describe('native push registration runtime boundary', () => {
  beforeEach(() => {
    runtimeKey = 'host-a'; notificationEnabled = true; permission = 'granted';
    permissionRequests = 0; deviceRegistrations = 0; deviceUnregistrations = 0;
    listeners.clear(); endpointListeners.clear(); serverRegistrations.length = 0; serverUnregistrations.length = 0;
    serverResponse = async () => ({ ok: true });
  });
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    root = null; restore?.(); restore = null;
  });
  test('registers again after switching hosts and removes old listeners', async () => {
    await mount(); await emitToken();
    expect(status.registration).toBe('registered');
    await switchHost('host-b'); await emitToken();
    expect(deviceRegistrations).toBe(2);
    expect(serverRegistrations.map((item) => item.runtimeKey)).toEqual(['host-a', 'host-b']);
    expect(listeners.get('registration')?.size).toBe(1);
    expect(listeners.get('registrationError')?.size).toBe(1);
  });
  test('late old-host success cannot mark the new host registered', async () => {
    let complete!: (value: { ok: true }) => void;
    serverResponse = () => new Promise((resolve) => { complete = resolve; });
    await mount(); await emitToken();
    expect(status.registration).toBe('registering');
    await switchHost('host-b');
    await act(async () => { complete({ ok: true }); }); await flush();
    expect(status.registration).toBe('registering');
    expect(serverRegistrations).toHaveLength(1);
  });
  test('denied permission is surfaced and never prompts repeatedly', async () => {
    permission = 'denied'; await mount();
    expect(permissionRequests).toBe(0);
    expect(deviceRegistrations).toBe(0);
    expect(status.permission).toBe('denied');
    expect(status.registration).toBe('failed');
  });
  test('new permission prompts once and a failed host acknowledgment stays failed', async () => {
    permission = 'prompt'; serverResponse = async () => null;
    await mount(); await emitToken();
    expect(permissionRequests).toBe(1);
    expect(status.registration).toBe('failed');
    expect(status.error).not.toContain('test-device-token');
  });
  test('missing iOS push entitlement is actionable without leaking the native error', async () => {
    await mount();
    await act(async () => {
      listeners.get('registrationError')?.forEach((listener) => listener({ error: 'no valid aps-environment entitlement; private-device-data' }));
    });
    await flush();
    expect(status.registration).toBe('failed');
    expect(status.error).toContain('push-enabled provisioning profile');
    expect(status.error).not.toContain('private-device-data');
    expect(serverRegistrations).toHaveLength(0);
  });
  test('turning off notifications unregisters the current device and host', async () => {
    await mount(); await emitToken();
    await act(async () => { notificationEnabled = false; root!.render(<Harness />); }); await flush();
    expect(deviceUnregistrations).toBe(1);
    expect(serverUnregistrations).toEqual(['host-a']);
    expect(status.registration).toBe('disabled');
  });
  test('old token removal is never sent to a different host', async () => {
    await mount(); await emitToken(); await switchHost('host-b');
    await act(async () => { notificationEnabled = false; root!.render(<Harness />); }); await flush();
    expect(serverUnregistrations).toEqual([]);
    expect(deviceUnregistrations).toBe(1);
  });
  test('unmount cleans native and runtime listeners', async () => {
    await mount();
    await act(async () => { root!.unmount(); }); root = null;
    expect(listeners.get('registration')?.size).toBe(0);
    expect(listeners.get('registrationError')?.size).toBe(0);
    expect(endpointListeners.size).toBe(0);
  });
});
