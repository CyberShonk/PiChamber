// Selector stability: missing entries return one frozen fallback, never a fresh object.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';
import { useIssuesFilters, useIssuesSelection } from '@/stores/useGitHubIssuesStore';
import { usePullsFilters, usePullsSelection } from '@/stores/useGitHubPullRequestsStore';
import { useGitHubScope } from '@/stores/useGitHubScopeStore';
import { usePendingReviewCount } from '@/stores/github/useGitHubPendingReviewStore';

// Regression: selector hooks must return referentially stable fallbacks for
// missing entries. A fresh object per call changes zustand's snapshot every
// render and throws "Maximum update depth exceeded" on mount.

const installMinimalDom = (): (() => void) => {
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
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
};

const roots: Root[] = [];
const domRestores: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const restore of domRestores.splice(0)) restore();
});

const mountProbe = async (probe: () => unknown) => {
  domRestores.push(installMinimalDom());
  const container = (globalThis as unknown as { document: { body: Element } }).document.body;
  const root = createRoot(container);
  roots.push(root);
  const results: unknown[] = [];
  const Probe = () => {
    results.push(probe());
    return null;
  };
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  return results;
};

describe('GitHub selector hooks', () => {
  test('missing entries return a stable fallback across renders', async () => {
    const probes: Array<() => unknown> = [
      () => usePullsSelection(null),
      () => usePullsSelection('/tmp/unknown-repo'),
      () => useIssuesSelection(null),
      () => useGitHubScope(null),
      () => usePullsFilters('/tmp/unknown-repo', 'github.com/o/r'),
      () => useIssuesFilters('/tmp/unknown-repo', 'github.com/o/r'),
      () => usePendingReviewCount('github.com/o/r', 424242),
    ];
    for (const probe of probes) {
      const results = await mountProbe(probe);
      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const value of results) expect(value).toBe(results[0]);
    }
  });
});
