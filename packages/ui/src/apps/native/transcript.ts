import type { SessionMessageRecord } from '@/lib/chat/types';

type TranscriptEntry = { id: string; role: string; text: string; error: boolean; tools: Array<{ name: string; command?: string; output?: string }> };
/** Pure projection for explicit copy/search, not for the streaming render path. */
export const transcriptEntries = (records: readonly SessionMessageRecord[]): TranscriptEntry[] => records.map(({ info, parts }) => ({
  id: info.id,
  role: info.role ?? 'message',
  text: parts.filter((part) => part.type === 'text' && part.synthetic !== true).map((part) => typeof part.text === 'string' ? part.text : '').join('\n'),
  error: Boolean(info.error) || parts.some((part) => part.type === 'tool' && (part.state as { status?: string } | undefined)?.status === 'error'),
  tools: parts.filter((part) => part.type === 'tool').map((part) => {
    const state = part.state as { input?: { command?: unknown }; output?: unknown } | undefined;
    return { name: typeof part.tool === 'string' ? part.tool : 'Tool', command: typeof state?.input?.command === 'string' ? state.input.command : undefined, output: typeof state?.output === 'string' ? state.output : undefined };
  }),
}));
export const formatTranscript = (entries: readonly TranscriptEntry[]): string => entries.map((entry) => `## ${entry.role}\n\n${entry.text}${entry.tools.map((tool) => `\n\n### ${tool.name}\n\n${tool.command ?? ''}\n${tool.output ?? ''}`).join('')}`).join('\n\n');
