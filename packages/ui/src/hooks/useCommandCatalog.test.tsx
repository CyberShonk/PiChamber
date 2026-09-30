import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { CatalogCommand } from '@/lib/pi/commandCatalog';

type CommandRow = {
  name: string;
  description?: string;
  source: 'prompt' | 'extension' | 'skill';
  scope?: string;
};

let commandCalls = 0;
let listCommandsImpl: (directory?: string) => Promise<{ directory?: string; commands: CommandRow[] }>;
let runtimeKey = 'test-runtime';

mock.module('@/lib/pi/client', () => ({
  piClient: {
    listCommands: (directory?: string) => {
      commandCalls += 1;
      return listCommandsImpl(directory);
    },
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const { useCommandCatalog } = await import('./useCommandCatalog');
const { usePromptTemplatesStore } = await import('@/stores/usePromptTemplatesStore');
const { useSkillsStore } = await import('@/stores/useSkillsStore');
const {
  clearCommandCatalogForRuntimeSwitch,
  readCommandCatalogEntry,
} = await import('@/lib/pi/commandCatalog');

type Snapshot = { commands: CatalogCommand[]; isLoading: boolean };
let snapshots: Snapshot[] = [];

const Probe = ({ directory }: { directory?: string }) => {
  // Two mounts for the same directory, mirroring ChatInput (highlighting)
  // and CommandAutocomplete (dropdown) sharing one catalog.
  const first = useCommandCatalog(directory);
  const second = useCommandCatalog(directory);
  snapshots = [first, second];
  return null;
};

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
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

type Mount = { root: Root; restore: () => void };

const activeMounts: Mount[] = [];

const mountProbe = async (directory?: string): Promise<Mount> => {
  const dom = installMinimalDom();
  const container = (globalThis as unknown as { document: { body: unknown } }).document.body as unknown as Element;
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe directory={directory} />);
  });
  const mount = { root, restore: dom.restore };
  activeMounts.push(mount);
  return mount;
};

const unmountProbe = async (mount: Mount): Promise<void> => {
  const index = activeMounts.indexOf(mount);
  if (index >= 0) activeMounts.splice(index, 1);
  await act(async () => {
    mount.root.unmount();
  });
  mount.restore();
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await act(async () => {});
};

const reviewCommands = (tag: string): CommandRow[] => [
  { name: `review-${tag}`, description: 'Review', source: 'prompt', scope: 'global' },
];

const invocations = (snapshot: Snapshot): string[] =>
  snapshot.commands.map((command) => command.invocationName);

const setPromptStore = (prompts: Array<{ id: string; name: string; location: 'global' | 'project' | 'package' | 'path' }>) => {
  usePromptTemplatesStore.setState({
    prompts: prompts.map((prompt) => ({ ...prompt, editable: true })),
    isLoading: false,
    selectedPromptId: null,
    activeCacheKey: '',
    promptDraft: null,
  });
};

const setSkillStore = (skills: Array<{ id: string; name: string; scope: 'user' | 'project' }>) => {
  useSkillsStore.setState({
    skills: skills.map((skill) => ({
      ...skill,
      path: skill.id,
      source: 'agents' as const,
      location: (skill.scope === 'project' ? 'project' : 'global') as 'global' | 'project',
    })),
    isLoading: false,
    selectedSkillName: null,
  });
};

describe('useCommandCatalog request sharing', () => {
  beforeEach(() => {
    commandCalls = 0;
    runtimeKey = 'test-runtime';
    listCommandsImpl = async (directory) => ({ directory, commands: reviewCommands('v1') });
    clearCommandCatalogForRuntimeSwitch();
    setPromptStore([]);
    setSkillStore([]);
    snapshots = [];
  });

  afterEach(async () => {
    while (activeMounts.length > 0) {
      const mount = activeMounts.shift();
      if (mount) await unmountProbe(mount);
    }
    snapshots = [];
  });

  test('two mounts for the same scope share one request', async () => {
    const gate = deferred<{ directory?: string; commands: CommandRow[] }>();
    listCommandsImpl = () => gate.promise;
    const mount = await mountProbe('/work');
    expect(commandCalls).toBe(1);

    await act(async () => {
      gate.resolve({ directory: '/work', commands: reviewCommands('v1') });
      await gate.promise;
    });
    await flush();

    expect(commandCalls).toBe(1);
    expect(invocations(snapshots[0])).toContain('review-v1');
    expect(invocations(snapshots[1])).toContain('review-v1');
    // System commands are always present alongside fetched rows.
    expect(invocations(snapshots[0])).toContain('undo');
    expect(snapshots[0].isLoading).toBe(false);
    expect(snapshots[1].isLoading).toBe(false);
    await unmountProbe(mount);
  });

  test('remount within freshness issues zero requests', async () => {
    const first = await mountProbe('/work');
    await flush();
    expect(commandCalls).toBe(1);
    expect(invocations(snapshots[0])).toContain('review-v1');
    await unmountProbe(first);

    await mountProbe('/work');
    await flush();
    expect(commandCalls).toBe(1);
    expect(invocations(snapshots[0])).toContain('review-v1');
    expect(snapshots[0].isLoading).toBe(false);
  });

  test('a real signature change refetches', async () => {
    setPromptStore([{ id: 'p1', name: 'review', location: 'global' }]);
    setSkillStore([{ id: 's1', name: 'code-review', scope: 'user' }]);
    const mount = await mountProbe('/work');
    await flush();
    expect(commandCalls).toBe(1);
    expect(readCommandCatalogEntry('test-runtime', '/work')?.promptSignature).toContain('p1');

    listCommandsImpl = async (directory) => ({ directory, commands: reviewCommands('v2') });
    await act(async () => {
      setPromptStore([
        { id: 'p1', name: 'review', location: 'global' },
        { id: 'p2', name: 'plan', location: 'project' },
      ]);
    });
    await flush();
    expect(commandCalls).toBe(2);
    expect(invocations(snapshots[0])).toContain('review-v2');
    await unmountProbe(mount);
  });

  test('boot transition (fetch resolves before stores load) does not refetch', async () => {
    const gate = deferred<{ directory?: string; commands: CommandRow[] }>();
    listCommandsImpl = () => gate.promise;
    const mount = await mountProbe('/work');
    expect(commandCalls).toBe(1);

    await act(async () => {
      gate.resolve({ directory: '/work', commands: reviewCommands('v1') });
      await gate.promise;
    });
    await flush();
    expect(invocations(snapshots[0])).toContain('review-v1');

    // Prompt/skill discovery settling after the commands fetch is the boot
    // race: the entry is adopted, not refetched.
    await act(async () => {
      setPromptStore([{ id: 'p1', name: 'review', location: 'global' }]);
      setSkillStore([{ id: 's1', name: 'code-review', scope: 'user' }]);
    });
    await flush();
    expect(commandCalls).toBe(1);
    expect(invocations(snapshots[0])).toContain('review-v1');
    const entry = readCommandCatalogEntry('test-runtime', '/work');
    expect(entry?.promptSignature).toContain('p1');
    expect(entry?.skillSignature).toContain('s1');
    await unmountProbe(mount);
  });

  test('boot transition (stores load mid-flight) shares the in-flight request', async () => {
    const gate = deferred<{ directory?: string; commands: CommandRow[] }>();
    listCommandsImpl = () => gate.promise;
    const mount = await mountProbe('/work');
    expect(commandCalls).toBe(1);

    await act(async () => {
      setPromptStore([{ id: 'p1', name: 'review', location: 'global' }]);
    });
    expect(commandCalls).toBe(1);

    await act(async () => {
      gate.resolve({ directory: '/work', commands: reviewCommands('v1') });
      await gate.promise;
    });
    await flush();
    expect(commandCalls).toBe(1);
    expect(invocations(snapshots[0])).toContain('review-v1');
    await unmountProbe(mount);
  });

  test('failure keeps the last-known catalog and is not marked fresh', async () => {
    setPromptStore([{ id: 'p1', name: 'review', location: 'global' }]);
    const mount = await mountProbe('/work');
    await flush();
    expect(commandCalls).toBe(1);
    expect(invocations(snapshots[0])).toContain('review-v1');

    listCommandsImpl = async () => {
      throw new Error('daemon down');
    };
    await act(async () => {
      setPromptStore([
        { id: 'p1', name: 'review', location: 'global' },
        { id: 'p2', name: 'plan', location: 'project' },
      ]);
    });
    await flush();
    expect(commandCalls).toBe(2);
    // Last-known catalog survives the failed refresh.
    expect(invocations(snapshots[0])).toContain('review-v1');
    expect(snapshots[0].isLoading).toBe(false);
    await unmountProbe(mount);

    // The failure did not mark the scope fresh: a remount retries.
    await mountProbe('/work');
    await flush();
    expect(commandCalls).toBe(3);
  });

  test('first-load failure renders system commands and retries on remount', async () => {
    listCommandsImpl = async () => {
      throw new Error('daemon down');
    };
    const mount = await mountProbe('/work');
    await flush();
    expect(commandCalls).toBe(1);
    expect(invocations(snapshots[0])).toContain('undo');
    expect(invocations(snapshots[0])).not.toContain('review-v1');
    expect(snapshots[0].isLoading).toBe(false);
    await unmountProbe(mount);

    await mountProbe('/work');
    await flush();
    expect(commandCalls).toBe(2);
  });

  test('a real store change mid-flight follows up once', async () => {
    setPromptStore([{ id: 'p1', name: 'review', location: 'global' }]);
    setSkillStore([{ id: 's1', name: 'code-review', scope: 'user' }]);
    const firstGate = deferred<{ directory?: string; commands: CommandRow[] }>();
    const secondGate = deferred<{ directory?: string; commands: CommandRow[] }>();
    const seen: number[] = [];
    listCommandsImpl = () => {
      seen.push(commandCalls);
      return seen.length === 1 ? firstGate.promise : secondGate.promise;
    };
    const mount = await mountProbe('/work');
    expect(commandCalls).toBe(1);

    await act(async () => {
      setSkillStore([
        { id: 's1', name: 'code-review', scope: 'user' },
        { id: 's2', name: 'explain', scope: 'user' },
      ]);
    });
    // The signature change shares the in-flight request instead of firing.
    expect(commandCalls).toBe(1);

    await act(async () => {
      firstGate.resolve({ directory: '/work', commands: reviewCommands('stale') });
      await firstGate.promise;
    });
    await flush();
    // The stale completion chains one follow-up under the new signatures.
    expect(commandCalls).toBe(2);

    await act(async () => {
      secondGate.resolve({ directory: '/work', commands: reviewCommands('fresh') });
      await secondGate.promise;
    });
    await flush();
    expect(commandCalls).toBe(2);
    expect(invocations(snapshots[0])).toContain('review-fresh');
    await unmountProbe(mount);
  });
});
