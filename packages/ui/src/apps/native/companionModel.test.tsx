import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompanionSurface } from './CompanionSurface';
import { allowedCompanionAction, attentionItems, boundedCompanionText, companionWidgets, safeCompanionImage, sessionBoard, type CompanionView } from './companionModel';
import { createCompanionRoutes } from './companionRoutes';
import { companionWorkspaceTab } from './companionNavigation';
import { summarizeSessionContext } from '@/components/layout/sessionContextSummary';
import { companionFrame } from './companionDocument';
import theme from './red-carbon-dark.json';
import type { Theme } from '@/types/theme';
import type { PiReducerSessionState } from '@/lib/pi/reducers/reducerTypes';
import type { LiveSessionRecord } from '@/sync/pi-session-catalog';
const record = (id: string, updatedAt = 1): LiveSessionRecord => ({ id, directory: '/workspace/project', title: id, archived: false, parentId: null, lifecycle: 'busy', hydrated: false, createdAt: 0, updatedAt });
const view: CompanionView = { tab: 'sessions', workspace: 'Project', connected: true, selectedSession: '', sessions: [{ title: '<script>private text</script>', project: 'Repo', state: 'busy', selected: true }], files: [], selectedFile: null, preview: null, loading: false, error: null, questions: [] };
test('catalog board is bounded and disconnected state cannot report live running work', () => {
  const records = Array.from({ length: 100 }, (_, index) => record(String(index), index));
  const board = sessionBoard(records, '99', false);
  expect(board.length).toBe(50); expect(board[0].selected).toBe(true); expect(board[0].state).toBe('offline');
});
test('action schema rejects unknown navigation, malformed indices and choices', () => {
  expect(allowedCompanionAction({ scope: 1, type: 'tab', tab: 'review' })).toBe(true);
  expect(allowedCompanionAction({ scope: 1, type: 'file', index: -1 })).toBe(false);
  expect(allowedCompanionAction({ scope: 1, type: 'answer', index: 0, choice: 100 })).toBe(false);
  expect(allowedCompanionAction({ scope: Number.NaN, type: 'refresh' })).toBe(false);
});
test('image preview accepts only bounded raster data, never SVG or remote URLs', () => {
  expect(safeCompanionImage('data:image/png;base64,YWJj')).toBe(true);
  expect(safeCompanionImage('data:image/svg+xml;base64,YWJj')).toBe(false);
  expect(safeCompanionImage('https://host/private-image')).toBe(false);
  expect(safeCompanionImage('data:image/png;base64,' + 'a'.repeat(2_000_000))).toBe(false);
});
test('shared surface escapes user text, uses shared buttons and has no text inputs', () => {
  const html = renderToStaticMarkup(<CompanionSurface view={view} />);
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>private');
  expect(html).toContain('data-slot="button"'); expect(html).toContain('href="#oc-git-branch"');
  expect(html).not.toContain('<input'); expect(html).not.toContain('<textarea'); expect(html).not.toContain('Thinking');
});
test('local frame excludes external styles and blocks network/connect/frame/form access', () => {
  const frame = companionFrame(renderToStaticMarkup(<CompanionSurface view={view} />), theme as Theme, 2, 1, ['https://localhost/assets/app.css', 'https://remote/assets/unsafe.css', 'https://localhost/api/private.css']);
  expect(frame.document).toContain('https://localhost/assets/app.css'); expect(frame.document).not.toContain('https://remote'); expect(frame.document).not.toContain('/api/private');
  expect(frame.document).toContain("connect-src 'none'"); expect(frame.document).toContain("frame-src 'none'"); expect(frame.document).toContain("form-action 'none'");
  expect(frame.html).toContain('--surface-background: #070809');
  expect(frame.html).toContain('&lt;script&gt;private text&lt;/script&gt;');
  expect(frame.html).toContain('data-caction="session"');
});

test('workspace filtering happens before the catalog bound', () => {
  const records = Array.from({ length: 70 }, (_, index) => ({ ...record(String(index), index), directory: '/other' }));
  records.push({ ...record('old-workspace', 0), directory: '/workspace/project' });
  expect(sessionBoard(records, null, true, '/workspace/project').map((item) => item.id)).toEqual(['old-workspace']);
});
test('large dialog context routes to the top instead of offering truncated approval', () => {
  const request = { requestId: '1', method: 'confirm' as const, title: 'Confirm', message: 'x'.repeat(2001) };
  const state = { extensionDialogs: [request] } as PiReducerSessionState;
  expect(attentionItems(new Map([['session', state]]), new Map())[0].options).toEqual([]);
  state.extensionDialogs = [{ ...request, message: 'Full context' }];
  expect(attentionItems(new Map([['session', state]]), new Map())[0].options).toEqual(['Confirm', 'Cancel']);
});
test('previews and widget content have bounded line and character counts', () => {
  expect(boundedCompanionText('line\n'.repeat(2001))).toContain('Preview truncated');
  expect(boundedCompanionText('x'.repeat(120001)).length).toBeLessThan(120100);
  const widgets = companionWidgets(new Map([['one', { lines: ['x'.repeat(20000)], placement: 'aboveEditor' }]]));
  expect(widgets[0][1].lines.join('\n')).toContain('Widget truncated');
  expect(widgets[0][1].lines.join('\n').length).toBeLessThan(16100);
});
test('companion Extensions reuses the widget surface and preserves ANSI color without allowing markup', () => {
  const html = renderToStaticMarkup(<CompanionSurface view={{ ...view, tab: 'extensions', widgets: [['task-state', { lines: ['\x1b[38;2;255;100;100mReady\x1b[0m', '<img onerror="bad">'], placement: 'aboveEditor' }]] }} />);
  expect(html).toContain('data-testid="extensions-surface"');
  expect(html).toContain('Task State'); expect(html).toContain('color:rgb(255, 100, 100)');
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<img onerror');
  expect(html).toContain('data-caction="widget"'); expect(html).not.toContain('<input');
});

test('workspace routing only moves input-free supported destinations', () => {
  expect(companionWorkspaceTab('changes')).toBe('review');
  expect(companionWorkspaceTab('files')).toBe('artifacts');
  expect(companionWorkspaceTab('extensions')).toBe('extensions');
  expect(companionWorkspaceTab('terminal')).toBeNull();
  expect(companionWorkspaceTab('pull-requests')).toBeNull();
  expect(companionWorkspaceTab('context')).toBe('context');
});

test('visible-frame indices survive queued updates but cannot cross a workspace owner', () => {
  const routes = createCompanionRoutes<{ owner: { id: number }; files: string[] }>();
  routes.remember(1, { owner: { id: 10 }, files: ['a', 'b'] });
  routes.remember(2, { owner: { id: 10 }, files: ['b', 'a'] });
  expect(routes.resolve(1, 10)?.files[0]).toBe('a');
  expect(routes.resolve(2, 10)?.files[0]).toBe('b');
  expect(routes.resolve(1, 11)).toBeUndefined();
  routes.remember(3, { owner: { id: 11 }, files: ['c'] });
  expect(routes.resolve(1, 11)).toBeUndefined();
  for (let scope = 4; scope < 40; scope++) routes.remember(scope, { owner: { id: 11 }, files: [] });
  expect(routes.resolve(3, 11)).toBeUndefined();
});


test('diff renders separate rows with preserved casing and escaped code', () => {
  const html = renderToStaticMarkup(<CompanionSurface view={{ ...view, tab: 'review', preview: { kind: 'diff', title: 'MainActivity.kt', content: 'diff --git a/MainActivity.kt b/MainActivity.kt\n@@ -2,2 +2,2 @@\n-old()\n+New(<script>)\n unchanged' } }} />);
  expect(html.match(/class="companion-diff-row /g)?.length).toBe(4);
  expect(html).toContain('New(&lt;script&gt;)');
  expect(html).not.toContain('<br');
  expect(html).toContain('companion-line-number');
});

test('idle session cards reserve title space for content and expose workspace scope', () => {
  const html = renderToStaticMarkup(<CompanionSurface view={{ ...view, sessions: [{ title: 'MainActivity Review', project: 'DroidModLoader', state: 'idle', selected: true }] }} />);
  expect(html).toContain('MainActivity Review'); expect(html).toContain('DroidModLoader');
  expect(html).not.toContain('>Idle<'); expect(html).toContain('aria-label="Session scope"');
  expect(html).toContain('companion-session-title');
});

test('companion Context is input-free and distinguishes missing usage from a full window', () => {
  const summary = summarizeSessionContext([], []);
  const html = renderToStaticMarkup(<CompanionSurface view={{ ...view, tab: 'context', context: summary }} />);
  expect(html).toContain('Awaiting usage'); expect(html).toContain('Cache read');
  expect(html).toContain('href="#oc-donut-chart"');
  expect(html).not.toContain('<input'); expect(html).not.toContain('role="progressbar"');
});


test('code previews expose local layout controls and collapse only the patch preamble', () => {
  const content = 'diff --git a/File.kt b/File.kt\n--- a/File.kt\n+++ b/File.kt\n@@ -5 +9 @@\n-old()\n+New(<script>)\n\\ No newline at end of file';
  const html = renderToStaticMarkup(<CompanionSurface view={{ ...view, tab: 'review', preview: { kind: 'diff', title: 'File.kt', content } }} />);
  expect(html).toContain('<details class="companion-patch-header">');
  expect(html).toContain('<summary>Patch details</summary>');
  expect(html).not.toContain('<details class="companion-patch-header" open');
  expect(html.match(/class="companion-line-number"/g)?.length).toBe(4);
  expect(html.indexOf('No newline')).toBeGreaterThan(html.indexOf('</details>'));
  expect(html).toContain('data-cpresentation="wrap"');
  expect(html).toContain('data-cpresentation="files"');
  expect(html).toContain('aria-controls="companion-file-list"');
  const source = renderToStaticMarkup(<CompanionSurface view={{ ...view, tab: 'artifacts', preview: { kind: 'text', title: 'File.kt', content: 'package Test\n\n<script>\n' } }} />);
  expect(source.match(/class="companion-line-number"/g)?.length).toBe(4);
  expect(source).toContain('&lt;script&gt;');
  expect(source).toContain('aria-label="File content"');
});

test('local layout toggles survive fresh frames and never reach the host action bridge', () => {
  const frame = companionFrame('', theme as Theme, 2, 1, []);
  const script = /<script nonce="companion-shell">([\s\S]*?)<\/script>/.exec(frame.document)![1];
  const attributes: Record<string, Record<string, string>> = { files: {}, wrap: {} };
  const root = {
    dataset: { filesHidden: 'false', codeWrap: 'true' },
    querySelector: (selector: string) => {
      const key = selector.includes('files') ? 'files' : 'wrap';
      return { setAttribute: (name: string, value: string) => { attributes[key][name] = value; } };
    },
  };
  const listeners: Record<string, (event: unknown) => void> = {};
  const document = {
    querySelector: () => root,
    querySelectorAll: () => [],
    getElementById: () => ({ set innerHTML(_value: string) { root.dataset.filesHidden = 'false'; root.dataset.codeWrap = 'true'; } }),
    addEventListener: (type: string, callback: (event: unknown) => void) => { listeners[type] = callback; },
  };
  const posts: string[] = [];
  const window: {
    CompanionActions: { post: (message: string) => void; scroll: () => void };
    companionRender: (html: string, scope: number, owner: number) => void;
  } = {
    CompanionActions: { post: (message: string) => { posts.push(message); }, scroll: () => undefined },
    companionRender: () => undefined,
  };
  new Function('window', 'document', script)(window, document);
  window.companionRender('frame 1', 1, 1);
  const click = (key: string) => listeners.click({ target: { closest: (selector: string) => selector === '[data-cpresentation]' ? { dataset: { cpresentation: key } } : null } });
  click('files');click('wrap');
  expect(root.dataset).toEqual({ filesHidden: 'true', codeWrap: 'false' });
  expect(attributes.files['aria-expanded']).toBe('false');
  expect(attributes.files['aria-label']).toBe('Show file list');
  expect(attributes.wrap['aria-pressed']).toBe('false');
  window.companionRender('frame 2', 2, 1);
  expect(root.dataset).toEqual({ filesHidden: 'true', codeWrap: 'false' });
  expect(posts).toHaveLength(0);
  listeners.click({ target: { closest: (selector: string) => selector === '[data-caction]' ? { dataset: { caction: 'refresh' } } : null } });
  expect(JSON.parse(posts[0])).toEqual({ scope: 2, type: 'refresh' });
  click('files');click('wrap');
  expect(root.dataset).toEqual({ filesHidden: 'false', codeWrap: 'true' });
});
