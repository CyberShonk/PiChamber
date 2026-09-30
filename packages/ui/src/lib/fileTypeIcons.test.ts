import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetFileTypeSpriteForTests,
  __setFileTypeSpriteLoaderForTests,
  getFileTypeIconHref,
  getFileTypeSpriteVersion,
  loadFileTypeSprite,
  subscribeFileTypeSprite,
} from './fileTypeIcons';

type StubElement = {
  id: string;
  tagName: string;
  children: StubElement[];
  markup: string[];
  style: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: StubElement) => StubElement;
  remove: () => void;
  querySelector: (selector: string) => StubElement | null;
  insertAdjacentHTML: (position: string, markup: string) => void;
};

const originalDocument = globalThis.document;
let body: StubElement;

const createStubElement = (tagName: string): StubElement => {
  const element: StubElement = {
    id: '',
    tagName,
    children: [],
    markup: [],
    style: {},
    setAttribute: () => {},
    appendChild: (child) => {
      element.children.push(child);
      return child;
    },
    remove: () => {
      body.children = body.children.filter((child) => child !== element);
    },
    querySelector: (selector) => {
      const visit = (node: StubElement): StubElement | null => {
        for (const child of node.children) {
          if (child.tagName === selector) return child;
          const nested = visit(child);
          if (nested) return nested;
        }
        return null;
      };
      return visit(element);
    },
    insertAdjacentHTML: (_position, markup) => {
      element.markup.push(markup);
    },
  };
  return element;
};

const mountedSymbolIds = (): string[] => {
  const defs = body.children[0]?.querySelector('defs');
  return (defs?.markup ?? []).map((markup) => /<symbol\b[^>]*\bid="([^"]+)"/.exec(markup)?.[1] ?? '');
};

const FAKE_SPRITE = [
  '<svg xmlns="http://www.w3.org/2000/svg">',
  '<symbol id="typescript" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></symbol>',
  '<symbol id="3d_light" viewBox="0 0 24 24"><use href="#3d"/></symbol>',
  '<symbol id="3d" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></symbol>',
  '</svg>',
].join('');

const immediateSpriteLoader = () => Promise.resolve({ default: FAKE_SPRITE });

beforeEach(() => {
  body = createStubElement('body');
  (globalThis as { document?: unknown }).document = {
    body,
    getElementById: (id: string) => body.children.find((child) => child.id === id) ?? null,
    createElement: (tagName: string) => createStubElement(tagName),
    createElementNS: (_ns: string, tagName: string) => createStubElement(tagName),
  };
  __resetFileTypeSpriteForTests();
  __setFileTypeSpriteLoaderForTests(immediateSpriteLoader);
});

afterEach(() => {
  __resetFileTypeSpriteForTests();
  (globalThis as { document?: unknown }).document = originalDocument;
});

describe('file type icon sprite', () => {
  test('returns the href synchronously while the sprite is still loading', async () => {
    let resolveLoad!: (module: { default: string }) => void;
    __setFileTypeSpriteLoaderForTests(
      () =>
        new Promise<{ default: string }>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    // Synchronous call: throws would fail the test, and the href is returned
    // before the sprite arrives.
    const href = getFileTypeIconHref('src/index.ts');
    expect(href).toBe('#typescript');
    // Nothing is mounted until the sprite arrives.
    expect(mountedSymbolIds()).toEqual([]);

    resolveLoad({ default: FAKE_SPRITE });
    await loadFileTypeSprite();
    expect(mountedSymbolIds()).toEqual(['typescript']);
  });

  test('mounts only requested symbols, once, plus the symbols they reference', async () => {
    expect(body.children).toHaveLength(0);
    expect(getFileTypeIconHref('src/index.ts')).toBe('#typescript');
    expect(getFileTypeIconHref('src/other.ts')).toBe('#typescript');
    // Still pending: the shared load has not resolved yet.
    expect(mountedSymbolIds()).toEqual([]);

    getFileTypeIconHref('scene.3d', { extension: '3d', themeVariant: 'light' });
    await loadFileTypeSprite();
    expect(mountedSymbolIds()).toEqual(['typescript', '3d_light', '3d']);
  });

  test('coalesces concurrent requests into a single import', async () => {
    let importCalls = 0;
    let resolveLoad!: (module: { default: string }) => void;
    __setFileTypeSpriteLoaderForTests(() => {
      importCalls += 1;
      return new Promise<{ default: string }>((resolve) => {
        resolveLoad = resolve;
      });
    });

    const first = loadFileTypeSprite();
    const second = loadFileTypeSprite();
    getFileTypeIconHref('src/index.ts');
    expect(first).toBe(second);
    expect(importCalls).toBe(1);

    resolveLoad({ default: FAKE_SPRITE });
    await first;
    await second;
    expect(importCalls).toBe(1);
    expect(mountedSymbolIds()).toEqual(['typescript']);
  });

  test('retries after a failed load without throwing from render paths', async () => {
    let attempts = 0;
    __setFileTypeSpriteLoaderForTests(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ default: FAKE_SPRITE });
    });

    expect(getFileTypeIconHref('src/index.ts')).toBe('#typescript');
    const failure = await loadFileTypeSprite().then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toBe('file-type sprite failed to load');
    expect(mountedSymbolIds()).toEqual([]);

    // A later request retries with a fresh import and mounts the pending icon.
    expect(getFileTypeIconHref('src/index.ts')).toBe('#typescript');
    await loadFileTypeSprite();
    expect(attempts).toBe(2);
    expect(mountedSymbolIds()).toEqual(['typescript']);
  });

  test('notifies subscribers once when the sprite becomes available', async () => {
    const seen: number[] = [];
    const unsubscribe = subscribeFileTypeSprite(() => {
      seen.push(getFileTypeSpriteVersion());
    });
    expect(getFileTypeSpriteVersion()).toBe(0);

    getFileTypeIconHref('src/index.ts');
    await loadFileTypeSprite();
    expect(seen).toEqual([1]);

    // Already loaded: further requests mount synchronously without renotifying.
    getFileTypeIconHref('src/other.ts');
    await loadFileTypeSprite();
    expect(seen).toEqual([1]);
    unsubscribe();
  });

  test('remounts after the sprite root is removed', async () => {
    getFileTypeIconHref('src/index.ts');
    await loadFileTypeSprite();
    expect(mountedSymbolIds()).toEqual(['typescript']);

    body.children = [];
    getFileTypeIconHref('src/index.ts');
    expect(mountedSymbolIds()).toEqual(['typescript']);
  });

  test('loads the real sprite chunk', async () => {
    __resetFileTypeSpriteForTests();
    expect(getFileTypeIconHref('src/index.ts')).toBe('#typescript');
    await loadFileTypeSprite();
    expect(mountedSymbolIds()).toEqual(['typescript']);

    getFileTypeIconHref('scene.3d', { extension: '3d', themeVariant: 'light' });
    expect(mountedSymbolIds()).toEqual(['typescript', '3d_light', '3d']);
  });
});
