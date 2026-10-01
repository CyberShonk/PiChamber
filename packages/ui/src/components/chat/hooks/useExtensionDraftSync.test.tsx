import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { piClient } from '@/lib/pi/client';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useExtensionDraftSync } from './useExtensionDraftSync';
import type { PiSessionEvent } from '@/lib/pi/protocol';

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();

  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: (type: string, listener: () => void) => {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      documentListeners.get(type)?.delete(listener);
    },
  };
  const rootElement = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = rootElement;
  documentStub.body = rootElement;

  const windowStub: Record<string, unknown> = {
    ...globalThis,
    addEventListener: (type: string, listener: () => void) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      windowListeners.get(type)?.delete(listener);
    },
  };

  setGlobal('document', documentStub);
  setGlobal('window', windowStub);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: rootElement as unknown as Element,
    documentStub,
    dispatchWindowEvent: (type: string) => {
      windowListeners.get(type)?.forEach((cb) => cb());
    },
    dispatchDocumentEvent: (type: string) => {
      documentListeners.get(type)?.forEach((cb) => cb());
    },
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const flush = async (ms = 10) => {
  await act(async () => {
    await wait(ms);
  });
};

interface HarnessProps {
  sessionId?: string | null;
  directory?: string | null;
  text: string;
  debounceMs?: number;
}

const Harness = ({ sessionId, directory, text, debounceMs = 50 }: HarnessProps) => {
  useExtensionDraftSync({ sessionId, directory, text, debounceMs });
  return null;
};

describe('useExtensionDraftSync', () => {
  let dom: ReturnType<typeof installMinimalDom>;
  let root: Root;
  const originalUpdate = piClient.updateExtensionDraft;
  let draftCalls: Array<{ sessionId: string; text: string; revision: number; directory?: string }> = [];

  const emitStoreEvent = (event: PiSessionEvent) => {
    const store = getPiSessionStore() as unknown as { commitEvents: (events: readonly PiSessionEvent[]) => void };
    store.commitEvents([event]);
  };

  beforeEach(() => {
    dom = installMinimalDom();
    root = createRoot(dom.container);
    draftCalls = [];
    piClient.updateExtensionDraft = async (input) => {
      draftCalls.push(input);
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    dom.restore();
    piClient.updateExtensionDraft = originalUpdate;
  });

  test('no calls when untracked', async () => {
    await act(async () => {
      root.render(<Harness sessionId="sess-untracked" directory="/work" text="initial draft" debounceMs={20} />);
    });
    await flush(50);

    // Text changed while untracked
    await act(async () => {
      root.render(<Harness sessionId="sess-untracked" directory="/work" text="updated draft" debounceMs={20} />);
    });
    await flush(50);

    expect(draftCalls).toHaveLength(0);
  });

  test('sends immediately when becoming tracked', async () => {
    // 1. Mount with untracked session
    await act(async () => {
      root.render(<Harness sessionId="sess-track-1" directory="/work" text="hello draft" debounceMs={20} />);
    });
    await flush(10);
    expect(draftCalls).toHaveLength(0);

    // 2. Extension requests tracking
    await act(async () => {
      emitStoreEvent({
        protocolVersion: 1,
        kind: 'event',
        name: 'extension.editor.track',
        sequence: 1,
        sessionId: 'sess-track-1',
        directory: '/work',
        payload: { enabled: true },
      });
    });
    await flush(10);

    // Immediate send triggered on becoming tracked
    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0].sessionId).toBe('sess-track-1');
    expect(draftCalls[0].text).toBe('hello draft');
    expect(draftCalls[0].directory).toBe('/work');
    expect(typeof draftCalls[0].revision).toBe('number');
  });

  test('debounces and coalesces rapid typing and skips unchanged text', async () => {
    // Mark session as tracked first
    emitStoreEvent({
      protocolVersion: 1,
      kind: 'event',
      name: 'extension.editor.track',
      sequence: 1,
      sessionId: 'sess-debounce',
      directory: '/work',
      payload: { enabled: true },
    });

    // Mount - sends initial draft immediately
    await act(async () => {
      root.render(<Harness sessionId="sess-debounce" directory="/work" text="a" debounceMs={40} />);
    });
    await flush(10);
    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0].text).toBe('a');

    // Rapid typing: "ab", "abc", "abcd" within debounce window
    await act(async () => {
      root.render(<Harness sessionId="sess-debounce" directory="/work" text="ab" debounceMs={40} />);
    });
    await flush(10);

    await act(async () => {
      root.render(<Harness sessionId="sess-debounce" directory="/work" text="abc" debounceMs={40} />);
    });
    await flush(10);

    await act(async () => {
      root.render(<Harness sessionId="sess-debounce" directory="/work" text="abcd" debounceMs={40} />);
    });

    // Before debounce finishes, no extra send yet
    expect(draftCalls).toHaveLength(1);

    // Wait for debounce to expire
    await flush(60);

    // Only one extra call with coalesced final value "abcd"
    expect(draftCalls).toHaveLength(2);
    expect(draftCalls[1].text).toBe('abcd');

    // Re-rendering with identical text should NOT trigger any new send
    await act(async () => {
      root.render(<Harness sessionId="sess-debounce" directory="/work" text="abcd" debounceMs={40} />);
    });
    await flush(60);
    expect(draftCalls).toHaveLength(2);
  });

  test('generates strictly increasing revisions across sends', async () => {
    emitStoreEvent({
      protocolVersion: 1,
      kind: 'event',
      name: 'extension.editor.track',
      sequence: 1,
      sessionId: 'sess-rev',
      directory: '/work',
      payload: { enabled: true },
    });

    await act(async () => {
      root.render(<Harness sessionId="sess-rev" directory="/work" text="1" debounceMs={20} />);
    });
    await flush(10);

    await act(async () => {
      root.render(<Harness sessionId="sess-rev" directory="/work" text="2" debounceMs={20} />);
    });
    await flush(40);

    await act(async () => {
      root.render(<Harness sessionId="sess-rev" directory="/work" text="3" debounceMs={20} />);
    });
    await flush(40);

    expect(draftCalls).toHaveLength(3);
    const rev1 = draftCalls[0].revision;
    const rev2 = draftCalls[1].revision;
    const rev3 = draftCalls[2].revision;
    expect(rev2).toBeGreaterThan(rev1);
    expect(rev3).toBeGreaterThan(rev2);
  });

  test('retries sending draft when document becomes active via focus or visibilitychange', async () => {
    // 1. Start with inactive/hidden document
    dom.documentStub.visibilityState = 'hidden';
    dom.documentStub.hasFocus = () => false;

    // 2. Track session
    emitStoreEvent({
      protocolVersion: 1,
      kind: 'event',
      name: 'extension.editor.track',
      sequence: 1,
      sessionId: 'sess-focus',
      directory: '/work',
      payload: { enabled: true },
    });

    await act(async () => {
      root.render(<Harness sessionId="sess-focus" directory="/work" text="initial hidden draft" debounceMs={20} />);
    });
    await flush(30);

    // Initial send skipped because document is inactive
    expect(draftCalls).toHaveLength(0);

    // 3. Document becomes active and window receives focus
    dom.documentStub.visibilityState = 'visible';
    dom.documentStub.hasFocus = () => true;

    await act(async () => {
      dom.dispatchWindowEvent('focus');
    });
    await flush(10);

    // Now draft is sent
    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0].sessionId).toBe('sess-focus');
    expect(draftCalls[0].text).toBe('initial hidden draft');

    // 4. Test visibilitychange event as well
    dom.documentStub.visibilityState = 'hidden';
    await act(async () => {
      root.render(<Harness sessionId="sess-focus" directory="/work" text="updated while hidden" debounceMs={20} />);
    });
    await flush(40);
    // Debounce timer elapsed but document was inactive
    expect(draftCalls).toHaveLength(1);

    dom.documentStub.visibilityState = 'visible';
    await act(async () => {
      dom.dispatchDocumentEvent('visibilitychange');
    });
    await flush(10);

    expect(draftCalls).toHaveLength(2);
    expect(draftCalls[1].text).toBe('updated while hidden');
  });

  test('clears lastSent on request failure so subsequent change or focus retries', async () => {
    emitStoreEvent({
      protocolVersion: 1,
      kind: 'event',
      name: 'extension.editor.track',
      sequence: 1,
      sessionId: 'sess-fail',
      directory: '/work',
      payload: { enabled: true },
    });

    let failRequest = true;
    piClient.updateExtensionDraft = async (input) => {
      if (failRequest) {
        throw new Error('Network failure');
      }
      draftCalls.push(input);
    };

    // First attempt fails
    await act(async () => {
      root.render(<Harness sessionId="sess-fail" directory="/work" text="retryable draft" debounceMs={20} />);
    });
    await flush(30);
    expect(draftCalls).toHaveLength(0);

    // Server is healthy again; window focus should retry the same text
    failRequest = false;
    await act(async () => {
      dom.dispatchWindowEvent('focus');
    });
    await flush(10);

    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0].sessionId).toBe('sess-fail');
    expect(draftCalls[0].text).toBe('retryable draft');
  });
});
