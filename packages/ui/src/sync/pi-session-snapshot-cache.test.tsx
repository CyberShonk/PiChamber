import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';

// Switching the id a selector closes over must not return the previous
// entity when the store has not emitted: the cache is rebuilt per topic/key.

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

const roots: Root[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  restores.splice(0).forEach((restore) => restore());
});

const installState = () => {
  const store = getPiSessionStore();
  const originalGetState = store.getState;
  const state = {
    ...originalGetState.call(store),
    reducer: { bySession: new Map([['a', { marker: 'A' }], ['b', { marker: 'B' }]]) },
  } as unknown as ReturnType<typeof store.getState>;
  store.getState = () => state;
  restores.push(() => { store.getState = originalGetState; });
  const dom = installMinimalDom();
  restores.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  return root;
};

const markerOf = (state: unknown, id: string) => (
  (state as { reducer: { bySession: Map<string, { marker: string }> } }).reducer.bySession.get(id)?.marker
);

describe('usePiSessionSnapshot cache scoping', () => {
  test('a topic that carries the id re-selects after an id switch', async () => {
    const root = installState();
    let latest: string | undefined;
    const Probe = ({ id }: { id: string }) => {
      latest = usePiSessionSnapshot((state) => markerOf(state, id), undefined, `session:${id}`);
      return null;
    };
    await act(async () => root.render(<Probe id="a" />));
    expect(latest).toBe('A');
    await act(async () => root.render(<Probe id="b" />));
    expect(latest).toBe('B');
  });

  test('cacheKey re-selects when the id is not part of the topic', async () => {
    const root = installState();
    let latest: string | undefined;
    const Probe = ({ id }: { id: string }) => {
      latest = usePiSessionSnapshot((state) => markerOf(state, id), undefined, 'dialogs', id);
      return null;
    };
    await act(async () => root.render(<Probe id="a" />));
    expect(latest).toBe('A');
    await act(async () => root.render(<Probe id="b" />));
    expect(latest).toBe('B');
  });
});
