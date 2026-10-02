import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { useSessionReducerPart } from '@/sync/sync-context';

// Expanding a settled tool row enables hydration without any store change.
// The hook must still return the full part instead of a cached null.

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const toolPart = {
  id: 'a1:tool:0',
  type: 'tool',
  tool: {
    name: 'subagent',
    toolCallId: 'call-1',
    state: 'completed',
    input: {},
    output: 'done',
    render: { call: ['call'], result: ['short'], resultExpanded: ['full'] },
  },
};

const roots: Root[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  restores.splice(0).forEach((restore) => restore());
});

describe('useSessionReducerPart', () => {
  test('returns the part when enabled after mount without a store change', async () => {
    const store = getPiSessionStore();
    const originalGetState = store.getState;
    const state = {
      ...originalGetState.call(store),
      reducer: { bySession: new Map([['s1', { parts: new Map([[toolPart.id, toolPart]]) }]]) },
    } as unknown as ReturnType<typeof store.getState>;
    store.getState = () => state;
    restores.push(() => { store.getState = originalGetState; });

    const dom = installMinimalDom();
    restores.push(dom.restore);

    let latest: ReturnType<typeof useSessionReducerPart> = null;
    const Probe = ({ enabled }: { enabled: boolean }) => {
      latest = useSessionReducerPart('s1', toolPart.id, enabled);
      return null;
    };

    const root = createRoot(dom.container);
    roots.push(root);
    await act(async () => root.render(<Probe enabled={false} />));
    expect(latest).toBeNull();

    await act(async () => root.render(<Probe enabled />));
    const hydrated = latest as unknown as { state?: { render?: { resultExpanded?: string[] } } } | null;
    expect(hydrated?.state?.render?.resultExpanded).toEqual(['full']);
  });
});
