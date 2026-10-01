import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart as ToolPartType } from '@/lib/chat/types';

mock.module('@/components/chat/markdown/markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
  highlightLinesInWorker: async () => [],
  highlightTokensInWorker: async () => null,
}));

const { default: ToolPart } = await import('./ToolPart');

describe('ToolPart extension rendering', () => {
  test('renders always-visible ANSI lines below header when collapsed', () => {
    const part: ToolPartType = {
      id: 'part-ext-1',
      type: 'tool',
      tool: 'subagent',
      callID: 'call-1',
      state: {
        status: 'completed',
        render: {
          call: ['\x1b[1mSubagent Task:\x1b[0m Analyze repo'],
          result: ['\x1b[32mFound 5 issues\x1b[0m', 'Summary complete'],
          resultExpanded: ['Found 5 issues in detail', 'Issue 1: ...', 'Issue 2: ...'],
        },
      },
    };

    const markup = renderToStaticMarkup(
      <ToolPart
        part={part}
        isExpanded={false}
        onToggle={() => {}}
        isMobile={false}
      />
    );

    // Header is rendered
    expect(markup).toContain('Subagent');
    // Extension render block is rendered
    expect(markup).toContain('data-chat-tool-extension-render="true"');
    expect(markup).toContain('Subagent Task:');
    expect(markup).toContain('Analyze repo');
    expect(markup).toContain('Found 5 issues');
    expect(markup).toContain('Summary complete');
    // Collapsed does NOT render resultExpanded
    expect(markup).not.toContain('Found 5 issues in detail');
  });

  test('renders expanded ANSI lines when isExpanded is true', () => {
    const part: ToolPartType = {
      id: 'part-ext-2',
      type: 'tool',
      tool: 'subagent',
      callID: 'call-2',
      state: {
        status: 'completed',
        render: {
          call: ['Subagent Task: Analyze repo'],
          result: ['Found 5 issues'],
          resultExpanded: ['Found 5 issues in detail', 'Issue 1: test error', 'Issue 2: lint warning'],
        },
      },
    };

    const markup = renderToStaticMarkup(
      <ToolPart
        part={part}
        isExpanded={true}
        onToggle={() => {}}
        isMobile={false}
      />
    );

    expect(markup).toContain('data-chat-tool-extension-render="true"');
    expect(markup).toContain('Subagent Task: Analyze repo');
    expect(markup).toContain('Found 5 issues in detail');
    expect(markup).toContain('Issue 1: test error');
    expect(markup).toContain('Issue 2: lint warning');
  });

  test('renders inline block for running tool without expansion', () => {
    const part: ToolPartType = {
      id: 'part-ext-3',
      type: 'tool',
      tool: 'subagent',
      callID: 'call-3',
      state: {
        status: 'running',
        render: {
          call: ['Subagent initializing...'],
          result: ['Running step 2/5'],
        },
      },
    };

    const markup = renderToStaticMarkup(
      <ToolPart
        part={part}
        isExpanded={false}
        onToggle={() => {}}
        isMobile={false}
      />
    );

    expect(markup).toContain('data-chat-tool-extension-render="true"');
    expect(markup).toContain('Subagent initializing...');
    expect(markup).toContain('Running step 2/5');
  });

  test('does not render extension block for generic tools without render lines', () => {
    const part: ToolPartType = {
      id: 'part-generic-1',
      type: 'tool',
      tool: 'bash',
      callID: 'call-gen-1',
      state: {
        status: 'completed',
        input: { command: 'echo hello' },
        output: 'hello\n',
      },
    };

    const markup = renderToStaticMarkup(
      <ToolPart
        part={part}
        isExpanded={false}
        onToggle={() => {}}
        isMobile={false}
      />
    );

    expect(markup).not.toContain('data-chat-tool-extension-render="true"');
  });
});
