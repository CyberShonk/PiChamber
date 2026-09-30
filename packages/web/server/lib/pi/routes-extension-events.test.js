import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { projectEventFrame, projectExtensionList, registerPiRuntimeRoutes } from './routes.js';

const frame = (event, payload, sequence = 1) => ({
  protocolVersion: 1,
  kind: 'event',
  event,
  sequence,
  payload: { sessionId: 'sess-1', directory: '/work', ...payload },
});

describe('extension public projections', () => {
  it('whitelists extension list fields and rejects path-shaped identities', () => {
    expect(projectExtensionList({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: 'economy', path: '/secret/economy.ts' }],
      commands: [{ name: 'balance', description: 'Switch mode', source: 'daemon-value', scope: 'global', path: '/secret' }],
    })).toEqual({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: 'economy' }],
      commands: [{ name: 'balance', description: 'Switch mode', source: 'extension', scope: 'global' }],
    });

    expect(() => projectExtensionList({
      directory: '/work',
      extensions: [{ id: '/secret/extension.ts', name: 'extension' }],
      commands: [],
    })).toThrow();
    expect(() => projectExtensionList({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: '../extension' }],
      commands: [],
    })).toThrow();
  });
  it('projects extension.ui panels with caps and removals', () => {
    const projected = projectEventFrame(frame('extension.ui', {
      id: 'subagents',
      title: 'Sub-agents',
      component: 'table',
      props: { columns: ['Agent'], rows: [['research']] },
      actions: [{ label: 'Clear', command: 'agents-clear' }],
    }));
    expect(projected).toMatchObject({
      name: 'extension.ui',
      payload: { id: 'subagents', title: 'Sub-agents', component: 'table' },
    });

    // Missing component and title is treated as an unregister.
    expect(projectEventFrame(frame('extension.ui', { id: 'gone' }))).toMatchObject({
      payload: { id: 'gone', removed: true },
    });

    // Invalid ids are dropped entirely.
    expect(projectEventFrame(frame('extension.ui', { id: '' }))).toBeNull();
    expect(projectEventFrame(frame('extension.ui', { id: `${'x'.repeat(200)}` }))).toBeNull();
  });

  it('projects extension.app payloads and rejects oversized html', () => {
    const projected = projectEventFrame(frame('extension.app', {
      appId: 'board',
      title: 'Board',
      html: '<button data-pichamber-command="run">Run</button>',
    }));
    expect(projected?.payload).toMatchObject({ appId: 'board', title: 'Board' });
    expect(projected?.payload.html).toContain('data-pichamber-command');

    expect(projectEventFrame(frame('extension.app', {
      appId: 'big',
      html: `${'<a>'.repeat(70_000)}`,
    }))).toBeNull();

    expect(projectEventFrame(frame('extension.app', { appId: 'gone', removed: true }))?.payload).toMatchObject({
      appId: 'gone',
      removed: true,
    });
  });

  it('projects bounded editor/title/catalog and tree invalidation events', () => {
    expect(projectEventFrame(frame('extension.editor', { text: 'draft' }))).toMatchObject({
      name: 'extension.editor', payload: { text: 'draft', mode: 'set' },
    });
    expect(projectEventFrame(frame('extension.editor', { text: 'inserted', mode: 'paste' }))).toMatchObject({
      name: 'extension.editor', payload: { text: 'inserted', mode: 'paste' },
    });
    expect(projectEventFrame(frame('extension.editor', { text: 'replacement', mode: 'set' }))).toMatchObject({
      name: 'extension.editor', payload: { text: 'replacement', mode: 'set' },
    });
    expect(projectEventFrame(frame('extension.editor', { text: 'x'.repeat(100_001) }))).toBeNull();
    expect(projectEventFrame(frame('extension.title', { title: 'Mode\u0000 Picker' }))).toMatchObject({
      payload: { title: 'Mode  Picker' },
    });
    expect(projectEventFrame(frame('extension.title', {}))).toMatchObject({ payload: {} });
    expect(projectEventFrame(frame('extension.catalog', { providers: true, resources: true }))).toMatchObject({
      payload: { providers: true, resources: true },
    });
    expect(projectEventFrame(frame('extension.catalog', {}))).toBeNull();
    expect(projectEventFrame(frame('session.tree.updated', {}))).toMatchObject({ payload: {} });
  });

  it('projects form dialogs with sanitized fields', () => {
    const projected = projectEventFrame(frame('extension.dialog', {
      requestId: 'form-1',
      method: 'form',
      title: 'Spawn agent',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'level', label: 'Level', type: 'select', options: ['low', 'high'], initial: 'high' },
        { id: 'bad' },
        null,
      ],
    }));
    expect(projected?.payload.method).toBe('form');
    expect(projected?.payload.fields).toHaveLength(2);
    expect(projected?.payload.fields[0]).toMatchObject({ id: 'name', type: 'text', required: true });
    expect(projected?.payload.fields[1]).toMatchObject({ id: 'level', initial: 'high', options: ['low', 'high'] });

    expect(projectEventFrame(frame('extension.dialog.dismiss', {
      requestId: 'form-1',
      reason: 'timeout',
    }))?.payload).toEqual({ requestId: 'form-1', reason: 'timeout' });
    expect(projectEventFrame(frame('extension.dialog.dismiss', {
      requestId: 'form-1',
      reason: 'invented',
    }))).toBeNull();

    // Unknown dialog methods fail closed: the frame is dropped.
    expect(projectEventFrame(frame('extension.dialog', {
      requestId: 'r1',
      method: 'hologram',
      title: '?',
    }))).toBeNull();
  });

  it('projects extension.working events and sanitizes/bounds payloads', () => {
    expect(projectEventFrame(frame('extension.working', { message: 'Thinking\u0000 deeply', visible: true }))).toMatchObject({
      name: 'extension.working',
      payload: { message: 'Thinking  deeply', visible: true },
    });
    expect(projectEventFrame(frame('extension.working', { visible: false }))).toMatchObject({
      name: 'extension.working',
      payload: { visible: false },
    });
    expect(projectEventFrame(frame('extension.working', { message: 'x'.repeat(250) }))?.payload.message).toHaveLength(200);
    expect(projectEventFrame(frame('extension.working', { message: 123, visible: 'yes' }))).toBeNull();
  });

  it('projects extension.editor.track events and ignores invalid frames', () => {
    expect(projectEventFrame(frame('extension.editor.track', { enabled: true }))).toMatchObject({
      name: 'extension.editor.track',
      payload: { enabled: true },
    });
    expect(projectEventFrame(frame('extension.editor.track', { enabled: false }))).toMatchObject({
      name: 'extension.editor.track',
      payload: { enabled: false },
    });
    expect(projectEventFrame(frame('extension.editor.track', { enabled: 'true' }))).toBeNull();
    expect(projectEventFrame(frame('extension.editor.track', {}))).toBeNull();
  });

  it('projects snapshot extensionPanels/extensionApps/extensionDraftTracked for reconnect', () => {
    const projected = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      extensionStatuses: [{ key: 'mode', text: 'economy' }],
      extensionPanels: [{ id: 'panel-1', component: 'progress', props: { value: 50 } }],
      extensionApps: [{ appId: 'app-1', html: '<p>x</p>' }],
      extensionTitle: 'Build mode',
      extensionWorking: { message: 'Indexing...', visible: true },
      extensionDraftTracked: true,
      extensionDialogs: [{
        requestId: 'form-1',
        method: 'form',
        title: 'Form',
        fields: [{ id: 'a', label: 'A', type: 'text' }],
      }],
    }));
    const snapshot = projected?.payload.snapshot;
    expect(snapshot.extensionPanels).toHaveLength(1);
    expect(snapshot.extensionApps).toHaveLength(1);
    expect(snapshot.extensionDialogs[0].fields).toHaveLength(1);
    expect(snapshot.extensionTitle).toBe('Build mode');
    expect(snapshot.extensionWorking).toEqual({ message: 'Indexing...', visible: true });
    expect(snapshot.extensionDraftTracked).toBe(true);

    const projectedUntracked = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      extensionDraftTracked: false,
    }));
    expect(projectedUntracked?.payload.snapshot.extensionDraftTracked).toBeUndefined();
  });
});

describe('POST /api/pi/sessions/:sessionId/editor-draft', () => {
  let server;

  const listen = (app) => new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  const close = (s) => new Promise((resolve, reject) => {
    if (!s) return resolve();
    s.close((err) => (err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve()));
  });

  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  it('validates payload and forwards valid drafts to daemon runtime returning 204', async () => {
    const calls = [];
    const runtime = {
      request: async (command, payload) => {
        calls.push({ command, payload });
        return { accepted: true };
      },
    };

    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/sessions/sess-123/editor-draft`;

    // 1. Valid request
    const validRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'draft content', revision: 5, directory: '/work' }),
    });
    expect(validRes.status).toBe(204);
    expect(calls).toEqual([
      { command: 'extensions.draft', payload: { sessionId: 'sess-123', text: 'draft content', revision: 5, directory: '/work' } },
    ]);

    // 2. Text not a string
    const badTextRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 123, revision: 1 }),
    });
    expect(badTextRes.status).toBe(400);
    await expect(badTextRes.json()).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } });

    // 3. Text exceeds 100,000 chars
    const oversizedRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(100_001), revision: 1 }),
    });
    expect(oversizedRes.status).toBe(400);
    await expect(oversizedRes.json()).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } });

    // 4. Invalid revision (negative, float, string, missing)
    const badRevisions = [-1, 1.5, '5', null, undefined, NaN, Number.MAX_SAFE_INTEGER + 1];
    for (const rev of badRevisions) {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', revision: rev }),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } });
    }

    // 5. Invalid directory (non-string)
    const badDirRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', revision: 1, directory: 123 }),
    });
    expect(badDirRes.status).toBe(400);
    await expect(badDirRes.json()).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } });
  });
});
