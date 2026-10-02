import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('../../../MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content?: unknown }) => {
    const text = typeof props.content === 'string' ? props.content : '';
    return React.createElement('div', { 'data-markdown-content': 'true' }, text);
  },
}));

const { ExtensionNoteRow } = await import('./ExtensionNoteRow');

const renderNoteRow = (props: Partial<Parameters<typeof ExtensionNoteRow>[0]>) =>
  renderToStaticMarkup(<ExtensionNoteRow messageId="note-1" {...props} />);

describe('ExtensionNoteRow', () => {
  test('renders a tool-style header with the raw customType, not a mangled label', () => {
    const markup = renderNoteRow({
      customType: 'ctx-ui-probe.note',
      text: 'Notification message',
    });

    expect(markup).toContain('data-extension-ui="note-1"');
    expect(markup).toContain('Extension');
    expect(markup).toContain('>ctx-ui-probe.note<');
    expect(markup).toContain('title="ctx-ui-probe.note"');
    expect(markup).not.toContain('ctx ui probe');
  });

  test('renders markdown text in normal text size', () => {
    const markup = renderNoteRow({
      customType: 'notifier',
      text: '**Important:** deployment complete',
    });

    expect(markup).toContain('**Important:** deployment complete');
  });

  test('has details collapsed by default without dumping raw JSON in static markup', () => {
    const markup = renderNoteRow({
      customType: 'analytics',
      text: 'Summary report',
      details: { totalUsers: 42, activeSessions: 7 },
    });

    expect(markup).toContain('Summary report');
    expect(markup).toContain('aria-label="Show analytics details"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('totalUsers');
    expect(markup).not.toContain('42');
  });

  test('renders without details button when neither data nor details is provided', () => {
    const markup = renderNoteRow({
      customType: 'simple-note',
      text: 'Just plain text',
    });

    expect(markup).toContain('Just plain text');
    expect(markup).not.toContain('aria-expanded');
  });
});
