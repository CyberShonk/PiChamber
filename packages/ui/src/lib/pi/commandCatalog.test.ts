import { beforeEach, describe, expect, test } from 'bun:test';

import {
  adoptCommandCatalogSignatures,
  buildSystemCatalogCommands,
  catalogInvocationSet,
  clearCommandCatalogForRuntimeSwitch,
  getCommandCatalogInvalidationRevision,
  invalidateCommandCatalogCache,
  isCommandCatalogEntryFresh,
  readCommandCatalogCache,
  readCommandCatalogEntry,
  subscribeCommandCatalogInvalidation,
  toCatalogCommands,
  writeCommandCatalogCache,
} from './commandCatalog';

describe('commandCatalog — executable invocation identity', () => {
  beforeEach(() => {
    clearCommandCatalogForRuntimeSwitch();
  });
  test('system commands expose bare invocations', () => {
    const system = buildSystemCatalogCommands();
    const byName = new Map(system.map((c) => [c.name, c]));
    for (const name of ['undo', 'redo', 'timeline', 'compact']) {
      const command = byName.get(name);
      expect(command).toBeDefined();
      expect(command?.invocationName).toBe(name);
      expect(command?.source).toBe('system');
    }
    // Supported system commands only: no TUI-only /reload, /model, /settings,
    // and no browser-unhandled /init.
    expect(byName.has('init')).toBe(false);
    expect(byName.has('reload')).toBe(false);
    expect(byName.has('model')).toBe(false);
    expect(byName.has('settings')).toBe(false);
  });

  test('prompt templates use /name', () => {
    const [command] = toCatalogCommands([
      { name: 'review', description: 'Review', source: 'prompt', scope: 'global' },
    ]);
    expect(command.name).toBe('review');
    expect(command.invocationName).toBe('review');
    expect(command.source).toBe('prompt');
  });

  test('skills use /skill:name, never bare /name', () => {
    const [command] = toCatalogCommands([
      { name: 'skill:code-review', description: 'Review', source: 'skill', scope: 'global' },
    ]);
    expect(command.name).toBe('code-review');
    expect(command.invocationName).toBe('skill:code-review');
    expect(command.source).toBe('skill');
  });

  test('bare skill names from older payloads are normalized to skill: prefix', () => {
    const [command] = toCatalogCommands([
      // Defensive: server always sends skill:xxx, but never emit bare.
      { name: 'code-review', description: 'Review', source: 'skill' } as never,
    ]);
    expect(command.invocationName).toBe('skill:code-review');
  });

  test('extension commands keep their registered invocation including suffixes', () => {
    const [first, second] = toCatalogCommands([
      { name: 'hello', description: 'Hi', source: 'extension' },
      { name: 'hello:2', description: 'Hi again', source: 'extension' },
    ]);
    expect(first.invocationName).toBe('hello');
    expect(second.invocationName).toBe('hello:2');
  });

  test('catalog ids stay stable when command order changes', () => {
    const commands = [
      { name: 'review', source: 'prompt' as const, scope: 'global' },
      { name: 'skill:code-review', source: 'skill' as const, scope: 'global' },
    ];
    const forward = new Map(toCatalogCommands(commands).map((command) => [command.invocationName, command.id]));
    const reversed = new Map(toCatalogCommands([...commands].reverse()).map((command) => [command.invocationName, command.id]));
    expect(reversed).toEqual(forward);
  });

  test('cache invalidation publishes a revision for mounted catalog hooks', () => {
    const before = getCommandCatalogInvalidationRevision();
    let notifications = 0;
    const unsubscribe = subscribeCommandCatalogInvalidation(() => {
      notifications += 1;
    });
    invalidateCommandCatalogCache('/work');
    unsubscribe();
    expect(getCommandCatalogInvalidationRevision()).toBe(before + 1);
    expect(notifications).toBe(1);
  });

  test('skill names with dashes and underscores survive', () => {
    const [dash, underscore] = toCatalogCommands([
      { name: 'skill:code-review', source: 'skill' },
      { name: 'skill:my_skill', source: 'skill' },
    ]);
    expect(dash.invocationName).toBe('skill:code-review');
    expect(underscore.invocationName).toBe('skill:my_skill');
  });

  test('invocation set drives tokenizer membership (bare skill never matches)', () => {
    const catalog = [
      ...buildSystemCatalogCommands(),
      ...toCatalogCommands([
        { name: 'review', source: 'prompt' },
        { name: 'skill:code-review', source: 'skill' },
        { name: 'hello', source: 'extension' },
      ]),
    ];
    const known = catalogInvocationSet(catalog);
    expect(known.has('review')).toBe(true);
    expect(known.has('skill:code-review')).toBe(true);
    expect(known.has('hello')).toBe(true);
    expect(known.has('undo')).toBe(true);
    expect(known.has('code-review')).toBe(false);
  });
});

describe('commandCatalog — freshness and signature adoption', () => {
  beforeEach(() => {
    clearCommandCatalogForRuntimeSwitch();
  });

  test('written entries record fetch time and validating signatures', () => {
    const before = Date.now();
    writeCommandCatalogCache('runtime-1', '/work', toCatalogCommands([
      { name: 'review', source: 'prompt', scope: 'global' },
    ]), { promptSignature: 'p1', skillSignature: 's1' });
    const entry = readCommandCatalogEntry('runtime-1', '/work');
    expect(entry?.commands.map((c) => c.invocationName)).toEqual(['review']);
    expect(entry?.promptSignature).toBe('p1');
    expect(entry?.skillSignature).toBe('s1');
    expect(entry!.fetchedAt >= before).toBe(true);
    expect(entry!.fetchedAt <= Date.now()).toBe(true);
    expect(isCommandCatalogEntryFresh(entry!)).toBe(true);
    expect(readCommandCatalogCache('runtime-1', '/work')?.map((c) => c.invocationName)).toEqual(['review']);
  });

  test('entries default to empty signatures for writers that do not track stores', () => {
    writeCommandCatalogCache('runtime-1', '/work', []);
    const entry = readCommandCatalogEntry('runtime-1', '/work');
    expect(entry?.promptSignature).toBe('');
    expect(entry?.skillSignature).toBe('');
  });

  test('stale entries fail the freshness check', () => {
    writeCommandCatalogCache('runtime-1', '/work', [], {
      promptSignature: 'p1',
      skillSignature: 's1',
      fetchedAt: Date.now() - 31_000,
    });
    const entry = readCommandCatalogEntry('runtime-1', '/work');
    expect(isCommandCatalogEntryFresh(entry!)).toBe(false);
  });

  test('adopting signatures keeps commands and fetch time untouched', () => {
    const fetchedAt = Date.now() - 5_000;
    writeCommandCatalogCache('runtime-1', '/work', toCatalogCommands([
      { name: 'review', source: 'prompt', scope: 'global' },
    ]), { fetchedAt });
    expect(adoptCommandCatalogSignatures('runtime-1', '/work', 'p1', 's1')).toBe(true);
    const entry = readCommandCatalogEntry('runtime-1', '/work');
    expect(entry?.promptSignature).toBe('p1');
    expect(entry?.skillSignature).toBe('s1');
    expect(entry?.fetchedAt).toBe(fetchedAt);
    expect(entry?.commands.map((c) => c.invocationName)).toEqual(['review']);
    expect(isCommandCatalogEntryFresh(entry!)).toBe(true);
  });

  test('adopting a missing scope reports false', () => {
    expect(adoptCommandCatalogSignatures('runtime-1', '/missing', 'p1', 's1')).toBe(false);
  });

  test('invalidation and runtime switches drop entries', () => {
    writeCommandCatalogCache('runtime-1', '/work', [], { promptSignature: 'p1', skillSignature: 's1' });
    invalidateCommandCatalogCache('/work');
    expect(readCommandCatalogEntry('runtime-1', '/work')).toBeUndefined();
    writeCommandCatalogCache('runtime-1', '/work', []);
    writeCommandCatalogCache('runtime-1', '/other', []);
    clearCommandCatalogForRuntimeSwitch();
    expect(readCommandCatalogEntry('runtime-1', '/work')).toBeUndefined();
    expect(readCommandCatalogEntry('runtime-1', '/other')).toBeUndefined();
  });

  test('directory scopes stay bounded', () => {
    for (let i = 0; i < 25; i += 1) {
      writeCommandCatalogCache('runtime-1', `/dir-${i}`, []);
    }
    expect(readCommandCatalogEntry('runtime-1', '/dir-0')).toBeUndefined();
    expect(readCommandCatalogEntry('runtime-1', '/dir-24')).toBeDefined();
  });
});
