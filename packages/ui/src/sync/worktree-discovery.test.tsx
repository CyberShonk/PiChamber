import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { GitWorktree } from '@/lib/api/types';

// Full-module mock (per-file isolation): a stable, counting git backend so the
// test observes the real `useWorktreeStore` freshness behavior underneath
// `WorktreeDiscovery`.
const gitCalls = { check: 0, worktrees: 0 };
const fakeWorktrees: GitWorktree[] = [
  { path: '/repo-a', branch: 'main', head: 'a', name: 'repo-a', isPrimary: true, detached: false, locked: false, prunable: false },
];
const fakeGit = {
  checkIsGitRepository: async () => { gitCalls.check += 1; return true; },
  listGitWorktrees: async () => { gitCalls.worktrees += 1; return fakeWorktrees; },
};

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ git: fakeGit }),
}));

const { WorktreeDiscovery } = await import('./worktree-discovery');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useWorktreeStore } = await import('@/stores/useWorktreeStore');
const { getRuntimeKey } = await import('@/lib/runtime-switch');

const listeners = new Map<string, Set<() => void>>();
const restoreFns: Array<() => void> = [];

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
    visibilityState: 'visible',
    activeElement: null,
    documentElement: { getAttribute: () => null },
    addEventListener: (type: string, listener: () => void) => {
      let set = listeners.get(`document:${type}`);
      if (!set) { set = new Set(); listeners.set(`document:${type}`, set); }
      set.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(`document:${type}`)?.delete(listener);
    },
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
  const fireHandlers = new Map<string, Set<() => void>>();
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('addEventListener', (type: string, listener: () => void) => {
    let set = fireHandlers.get(type);
    if (!set) { set = new Set(); fireHandlers.set(type, set); }
    set.add(listener);
  });
  setGlobal('removeEventListener', (type: string, listener: () => void) => {
    fireHandlers.get(type)?.delete(listener);
  });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: container as unknown as Element,
    fire: (type: string) => { fireHandlers.get(type)?.forEach((listener) => listener()); },
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

afterEach(() => {
  listeners.clear();
  while (restoreFns.length > 0) restoreFns.pop()!();
});

describe('WorktreeDiscovery', () => {
  test('focus within the freshness window does not refetch', async () => {
    gitCalls.check = 0;
    gitCalls.worktrees = 0;
    useWorktreeStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    useProjectsStore.setState({ projects: [{ id: 'a', path: '/repo-a' }] as never });

    const dom = installMinimalDom();
    restoreFns.push(dom.restore);
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => root.render(React.createElement(WorktreeDiscovery)));
      await flush();
      // Mount discovery: one check + one worktree list.
      expect(gitCalls).toEqual({ check: 1, worktrees: 1 });

      // Window regains focus (e.g. clicking back from DevTools) inside the
      // 30 s freshness window: no new network.
      await act(async () => { dom.fire('focus'); });
      await flush();
      expect(gitCalls).toEqual({ check: 1, worktrees: 1 });

      // Project-array identity churn with the same path set must not trigger
      // a second full discovery pass either.
      await act(async () => {
        useProjectsStore.setState({ projects: [{ id: 'a', path: '/repo-a' }] as never });
      });
      await flush();
      expect(gitCalls).toEqual({ check: 1, worktrees: 1 });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
