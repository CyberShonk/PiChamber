import { beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { createReducerPartMap, type PiReducerSessionState } from '@/lib/pi/reducers/reducerTypes';
import { ExtensionPromptDock } from './ExtensionPromptDock';

const createTestSession = (sessionId: string, directory = '/repo'): PiReducerSessionState => ({
  sessionId,
  directory,
  lastSequence: 0,
  lifecycle: 'idle',
  messages: new Map(),
  partOrder: new Map(),
  parts: createReducerPartMap(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  queue: { steering: 0, followUp: 0 },
  extensionStatuses: new Map(),
  extensionWidgets: new Map(),
  extensionDialogs: [],
  extensionNotices: [],
  extensionErrors: [],
  extensionPanels: new Map(),
  extensionApps: new Map(),
});

describe('ExtensionPromptDock', () => {
  const store = getPiSessionStore();

  beforeEach(() => {
    store.clear();
  });

  test('renders nothing when there are no pending dialogs', () => {
    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-1" />);
    expect(markup).toBe('');
  });

  test('renders select dialog with aria-label on listbox and stripped title on region', () => {
    const session = createTestSession('sess-1', '/repo');
    session.extensionDialogs = [
      {
        requestId: 'req-select',
        method: 'select',
        title: '\x1b[38;2;255;100;100mChoose Mode\x1b[0m',
        message: 'Select an operating mode:',
        options: ['Fast', 'Balanced', 'Deep'],
      },
    ];
    store.getState().reducer.bySession.set('sess-1', session);
    store.getState().selectedSessionId = 'sess-1';

    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-1" />);
    expect(markup).toContain('aria-label="Choose Mode"');
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('Select an operating mode:');
    expect(markup).toContain('Fast');
    expect(markup).toContain('Balanced');
    expect(markup).toContain('Deep');
    expect(markup).toContain('role="dialog"');
    const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(`id="${describedBy}"`);
    // Roving tabindex: only the highlighted option is in the tab order.
    expect(markup.match(/role="option"[^>]*tabindex="0"/g)?.length).toBe(1);
    expect(markup.match(/role="option"[^>]*tabindex="-1"/g)?.length).toBe(2);
  });

  test('renders form dialog with number min and max constraints', () => {
    const session = createTestSession('sess-1', '/repo');
    session.extensionDialogs = [
      {
        requestId: 'req-form',
        method: 'form',
        title: 'Configure Parameters',
        fields: [
          {
            id: 'concurrency',
            label: 'Concurrency Limit',
            type: 'number',
            required: true,
            min: 1,
            max: 10,
            initial: '4',
          },
        ],
      },
    ];
    store.getState().reducer.bySession.set('sess-1', session);
    store.getState().selectedSessionId = 'sess-1';

    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-1" />);
    expect(markup).toContain('aria-label="Configure Parameters"');
    expect(markup).toContain('Concurrency Limit');
    expect(markup).toContain('type="number"');
    expect(markup).toContain('min="1"');
    expect(markup).toContain('max="10"');
    expect(markup).toContain('value="4"');
  });

  test('renders confirm dialog with Yes/No buttons', () => {
    const session = createTestSession('sess-1', '/repo');
    session.extensionDialogs = [
      {
        requestId: 'req-confirm',
        method: 'confirm',
        title: 'Delete Resource?',
        message: 'Are you sure you want to proceed?',
      },
    ];
    store.getState().reducer.bySession.set('sess-1', session);
    store.getState().selectedSessionId = 'sess-1';

    const markup = renderToStaticMarkup(<ExtensionPromptDock sessionId="sess-1" />);
    expect(markup).toContain('Delete Resource?');
    expect(markup).toContain('Are you sure you want to proceed?');
    expect(markup).toContain('Yes (Y)');
    expect(markup).toContain('No (N)');
  });
});
