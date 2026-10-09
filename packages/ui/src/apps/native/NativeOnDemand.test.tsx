import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
let retryClick: (() => void) | undefined;
mock.module('@/components/ui/button', () => ({ Button: ({ onClick }: { onClick: () => void }) => { retryClick = onClick; return null; } }));
const { NativeOnDemand } = await import('./NativeOnDemand');
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
let restore: (() => void) | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; restore?.(); retryClick = undefined; });
const mount = async (node: React.ReactNode) => { const dom = installDom(); restore = dom.restore; root = createRoot(dom.container); await act(async () => root!.render(node)); };

test('cold module completion renders the open surface without another interaction', async () => {
  let resolve!: (component: React.ComponentType<{ label: string }>) => void;
  const promise = new Promise<React.ComponentType<{ label: string }>>((done) => { resolve = done; });
  let label = '';
  await mount(<NativeOnDemand load={() => promise} componentProps={{ label: 'first open' }} />);
  expect(label).toBe('');
  await act(async () => { resolve((props) => { label = props.label; return null; }); await promise; });
  expect(label).toBe('first open');
});
test('failed module can be retried without closing the surface', async () => {
  let calls = 0;
  let renders = 0;
  const load = async () => { calls++; if (calls === 1) throw new Error('test failure'); return () => { renders++; return null; }; };
  await mount(<NativeOnDemand load={load} componentProps={{}} />);
  expect(retryClick).toBeDefined();
  await act(async () => { retryClick!(); });
  expect(calls).toBe(2);
  expect(renders).toBeGreaterThan(0);
});
test('a module arriving after close cannot mount the dismissed surface', async () => {
  let resolve!: (component: React.ComponentType<object>) => void;
  const promise = new Promise<React.ComponentType<object>>((done) => { resolve = done; });
  let renders = 0;
  await mount(<NativeOnDemand load={() => promise} componentProps={{}} />);
  await act(async () => root!.unmount()); root = null;
  await act(async () => { resolve(() => { renders++; return null; }); await promise; });
  expect(renders).toBe(0);
});
