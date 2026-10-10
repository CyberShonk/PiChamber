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
  expect(html.match(/class="companion-diff-row /g)?.length).toBe(5);
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
