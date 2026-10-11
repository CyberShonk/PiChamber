import React from 'react';
import type { Message, Part } from '@/lib/chat/types';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';

import { deriveMessageRole } from '@/components/chat/message/messageRole';
import { Icon } from "@/components/icon/Icon";
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  extractSessionMessageBreakdown,
  type DetailedTokenBreakdown,
} from '@/stores/utils/tokenUtils';
import { useSessions, useSessionMessageRecords } from '@/sync/sync-context';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import { summarizeSessionContext } from './sessionContextSummary';
import { useTransientValue } from '@/hooks/useTransientValue';
import {
  derivePartsLabel,
  deriveUserSnippet,
  formatAssistantTokens,
  formatMessagePreviewTime,
} from './rawMessagePreview';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { formatDateTimeForPreference } from '@/lib/timeFormat';

type SessionMessage = { info: Message; parts: Part[] };

type TokenBreakdown = DetailedTokenBreakdown;

type ContextBuckets = {
  user: number;
  assistant: number;
  tool: number;
  other: number;
};

const EMPTY_BUCKETS: ContextBuckets = {
  user: 0,
  assistant: 0,
  tool: 0,
  other: 0,
};

const extractTokenBreakdown = (message: SessionMessage): TokenBreakdown => extractSessionMessageBreakdown(message);

const pickString = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
};

const estimateTextLength = (value: unknown): number => {
  if (typeof value === 'string') {
    return value.length;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateTextLength(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + estimateTextLength(item), 0);
  }
  return 0;
};

const estimatePartChars = (part: Part, role: 'user' | 'assistant' | 'tool' | 'other'): ContextBuckets => {
  const partRecord = part as Record<string, unknown>;
  const type = typeof partRecord.type === 'string' ? partRecord.type : '';

  if (type === 'reasoning') {
    return {
      ...EMPTY_BUCKETS,
      assistant: estimateTextLength(partRecord.text) + estimateTextLength(partRecord.content),
    };
  }

  const directText = pickString(
    partRecord.text,
    partRecord.content,
    partRecord.value,
    (partRecord.source as { value?: unknown; text?: { value?: unknown } } | undefined)?.value,
    (partRecord.source as { value?: unknown; text?: { value?: unknown } } | undefined)?.text?.value,
  );

  if (type === 'tool' || role === 'tool') {
    const toolInputOutputLength =
      estimateTextLength(partRecord.input)
      + estimateTextLength(partRecord.output)
      + estimateTextLength(partRecord.error)
      + estimateTextLength((partRecord.call as { input?: unknown; output?: unknown; error?: unknown } | undefined)?.input)
      + estimateTextLength((partRecord.call as { input?: unknown; output?: unknown; error?: unknown } | undefined)?.output)
      + estimateTextLength((partRecord.call as { input?: unknown; output?: unknown; error?: unknown } | undefined)?.error);

    const toolPayloadLength =
      toolInputOutputLength
      + estimateTextLength(partRecord.raw)
      + Math.round(estimateTextLength(partRecord.metadata) * 0.25)
      + Math.round(estimateTextLength(partRecord.state) * 0.1);

    return { user: 0, assistant: 0, tool: toolPayloadLength, other: 0 };
  }

  if (role === 'user') {
    return { user: directText.length, assistant: 0, tool: 0, other: 0 };
  }

  if (role === 'assistant') {
    return { user: 0, assistant: directText.length, tool: 0, other: 0 };
  }

  return { user: 0, assistant: 0, tool: 0, other: directText.length };
};

const addBuckets = (target: ContextBuckets, value: ContextBuckets): ContextBuckets => ({
  user: target.user + value.user,
  assistant: target.assistant + value.assistant,
  tool: target.tool + value.tool,
  other: target.other + value.other,
});

const deriveRoleBucket = (message: SessionMessage): 'user' | 'assistant' | 'tool' | 'other' => {
  const roleInfo = deriveMessageRole(message.info);
  if (roleInfo.isUser) return 'user';
  if (roleInfo.role === 'assistant') return 'assistant';
  if (roleInfo.role === 'tool') return 'tool';
  return 'other';
};

const computeContextBreakdown = (
  sessionMessages: SessionMessage[],
  systemPrompt: string,
): ContextBuckets => {
  if (sessionMessages.length === 0) {
    return { ...EMPTY_BUCKETS };
  }

  const totalChars = sessionMessages.reduce<ContextBuckets>((acc, message) => {
    const role = deriveRoleBucket(message);
    let bucket = { ...EMPTY_BUCKETS };
    for (const part of message.parts) {
      bucket = addBuckets(bucket, estimatePartChars(part, role));
    }
    return addBuckets(acc, bucket);
  }, { ...EMPTY_BUCKETS });

  totalChars.user += systemPrompt.length;

  return {
    user: Math.ceil(totalChars.user / 4),
    assistant: Math.ceil(totalChars.assistant / 4),
    tool: Math.ceil(totalChars.tool / 4),
    other: Math.ceil(totalChars.other / 4),
  };
};

const formatNumber = (value: number): string => value.toLocaleString('en-US');

const formatMoney = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
};

const formatDateTime = (timestamp: number | null, timeFormatPreference: TimeFormatPreference): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  return formatDateTimeForPreference(timestamp, timeFormatPreference, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

export const ContextPanelContent: React.FC = () => {
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [expandedRawMessages, setExpandedRawMessages] = React.useState<Record<string, boolean>>({});
  const { value: copiedRawMessageId, show: showCopiedRawMessageId, clear: clearCopiedRawMessageId } = useTransientValue<string | null>(null, 2000);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const sessions = useSessions();
  const sessionMessages = useSessionMessageRecords(
    currentSessionId ?? '',
    currentSessionDirectory ?? undefined,
  );
  const providers = useConfigStore((state) => state.providers);

  React.useEffect(() => {
    setExpandedRawMessages((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    clearCopiedRawMessageId();
  }, [clearCopiedRawMessageId, currentSessionDirectory, currentSessionId]);

  const handleCopyRawMessage = React.useCallback(async (messageId: string, value: string) => {
    const result = await copyTextToClipboard(value);
    if (result.ok) showCopiedRawMessageId(messageId);
    else clearCopiedRawMessageId();
  }, [clearCopiedRawMessageId, showCopiedRawMessageId]);

  const viewModel = React.useMemo(() => {
    const currentSession = currentSessionId ? sessions.find((session) => session.id === currentSessionId) ?? null : null;

    const summary = summarizeSessionContext(sessionMessages, providers);
    const { tokenBreakdown, contextUsage, cacheHitRate, totalAssistantCost,
      providerModel, contextLimit, contextWindowTokens, usagePercent } = summary;

    const systemPrompt = ([...sessionMessages].reverse().find(
      (entry) => deriveMessageRole(entry.info).isUser && typeof (entry.info as { system?: unknown }).system === 'string',
    )?.info as { system?: string } | undefined)?.system || '';

    const computedBreakdown = computeContextBreakdown(sessionMessages, systemPrompt);

    const userTokens = computedBreakdown.user;
    const assistantTokens = computedBreakdown.assistant;
    const toolTokens = computedBreakdown.tool;
    // When Pi usage is present, the char/4 estimate is informational only; we
    // never subtract a synthetic total from real Pi input to invent an "Other"
    // bucket. The legacy fallback still derives "Other" from any leftover
    // input that the role estimate did not cover.
    const otherTokens = contextUsage
      ? 0
      : Math.max(0, tokenBreakdown.input - userTokens - assistantTokens - toolTokens);
    const breakdownTotal = userTokens + assistantTokens + toolTokens + otherTokens;

    const firstMessageTs = sessionMessages[0]?.info?.time?.created;
    const lastMessageTs = sessionMessages.length > 0
      ? sessionMessages[sessionMessages.length - 1]?.info?.time?.created
      : null;

    return {
      sessionTitle: getSessionDisplayTitle(currentSession),
      messagesCount: summary.messagesCount,
      userMessagesCount: summary.userMessagesCount,
      assistantMessagesCount: summary.assistantMessagesCount,
      createdAt: (currentSession?.time?.created ?? firstMessageTs ?? null) as number | null,
      lastActivityAt: (lastMessageTs ?? currentSession?.time?.created ?? null) as number | null,
      providerModel,
      tokenBreakdown,
      usagePercent,
      cacheHitRate,
      totalAssistantCost,
      contextLimit,
      contextWindowTokens,
      hasUsage: contextUsage !== undefined,
      breakdown: {
        user: userTokens,
        assistant: assistantTokens,
        tool: toolTokens,
        other: otherTokens,
      },
      breakdownTotal,
    };
  }, [currentSessionId, providers, sessionMessages, sessions]);

  if (!currentSessionId) {
    return (
        <div className="flex h-full items-center justify-center p-6 text-center typography-ui-label text-muted-foreground">
        {"Open a session to inspect context."}
      </div>
    );
  }

  const segments: Array<{ key: string; label: string; value: number; color: string }> = [
    { key: 'user', label: "User", value: viewModel.breakdown.user, color: 'var(--status-success)' },
    { key: 'assistant', label: "Assistant", value: viewModel.breakdown.assistant, color: 'var(--primary-base)' },
    { key: 'tool', label: "Tool Calls", value: viewModel.breakdown.tool, color: 'var(--status-warning)' },
    ...(viewModel.hasUsage ? [] : [{ key: 'other', label: "Other", value: viewModel.breakdown.other, color: 'var(--surface-muted-foreground)' }]),
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[52rem] px-5 py-6">

        {/* ── Session header ── */}
        <div className="mb-6">
          <h2 className="typography-ui-header font-semibold text-foreground truncate">{viewModel.sessionTitle}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground/70">
            <span>{viewModel.providerModel.providerName} / {viewModel.providerModel.modelName}</span>
            {viewModel.createdAt && (
              <>
                <span>&middot;</span>
                <span>{formatDateTime(viewModel.createdAt, timeFormatPreference)}</span>
              </>
            )}
          </div>
        </div>

        {/* ── Context usage ── */}
        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <span className="typography-micro text-muted-foreground">{"Context"}</span>
            <span className="typography-micro tabular-nums text-muted-foreground/70">
              {formatNumber(viewModel.contextWindowTokens)}
              {viewModel.contextLimit ? ` / ${formatNumber(viewModel.contextLimit)}` : ''}
            </span>
          </div>
          <div className="mt-2.5 flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
            {viewModel.usagePercent > 0 && (
              <div
                className="rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(0.5, viewModel.usagePercent)}%`,
                  backgroundColor: viewModel.usagePercent > 80 ? 'var(--status-warning)' : 'var(--primary-base)',
                }}
              />
            )}
          </div>
          <div className="mt-1.5 typography-micro font-medium tabular-nums text-foreground/80">
            {`${viewModel.usagePercent.toFixed(1)}% used`}
          </div>
        </div>

        {/* ── Stat grid ── */}
        <div className="mb-5 grid grid-cols-2 gap-2">
          {([
            { label: "Messages", value: formatNumber(viewModel.messagesCount) },
            { label: "User", value: formatNumber(viewModel.userMessagesCount) },
            { label: "Assistant", value: formatNumber(viewModel.assistantMessagesCount) },
            { label: "Cost", value: formatMoney(viewModel.totalAssistantCost) },
          ] as const).map((item) => (
            <div key={item.label} className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
              <div className="typography-micro text-muted-foreground/70">{item.label}</div>
              <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{item.value}</div>
            </div>
          ))}
        </div>

        {/* ── Last turn tokens ── */}
        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="typography-micro text-muted-foreground mb-2.5">{"Last Assistant Message"}</div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">
            {([
              { label: "Input", value: viewModel.tokenBreakdown.input, format: 'count' },
              { label: "Output", value: viewModel.tokenBreakdown.output, format: 'count' },
              { label: "Reasoning", value: viewModel.tokenBreakdown.reasoning, format: 'count' },
              { label: "Cache Read", value: viewModel.tokenBreakdown.cacheRead, format: 'count' },
              { label: "Cache Write", value: viewModel.tokenBreakdown.cacheWrite, format: 'count' },
              {
                label: "Cache Hit",
                value: viewModel.cacheHitRate.hasInput ? viewModel.cacheHitRate.percent : null,
                format: 'percent',
              },
            ] as const).map((item) => (
              <div key={item.label}>
                <div className="typography-micro text-muted-foreground/70">{item.label}</div>
                <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
                  {item.value !== null && item.value !== undefined
                    ? item.format === 'percent'
                      ? `${item.value.toFixed(1)}%`
                      : formatNumber(item.value)
                    : '—'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Context breakdown ── */}
        <div className="mb-6">
          <div className="flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
            {segments.map((segment) => {
              if (segment.value <= 0 || viewModel.breakdownTotal <= 0) return null;
              return (
                <div
                  key={segment.key}
                  style={{
                    width: `${(segment.value / viewModel.breakdownTotal) * 100}%`,
                    backgroundColor: segment.color,
                  }}
                />
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {segments.map((segment) => {
              const pct = viewModel.breakdownTotal > 0 ? (segment.value / viewModel.breakdownTotal) * 100 : 0;
              return (
                <div key={segment.key} className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: segment.color }} />
                  <span className="typography-micro text-muted-foreground/70">
                    {segment.label} <span className="tabular-nums">{pct.toFixed(0)}%</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Raw messages ── */}
        <div>
          <div className="typography-micro text-muted-foreground">{"Raw Messages"}</div>
          <div className="mt-2.5 space-y-1">
            {[...sessionMessages].reverse().map((message) => {
              const roleInfo = deriveMessageRole(message.info);
              const role = roleInfo.role;
              const isAssistant = role === 'assistant';
              const isUser = role === 'user';
              const isExpanded = expandedRawMessages[message.info.id] === true;
              const isCopied = copiedRawMessageId === message.info.id;
              const messageCreatedAt = (message.info.time?.created ?? null) as number | null;
              const partsLabel = derivePartsLabel(message.parts);
              const tokens = isAssistant ? extractTokenBreakdown({ info: message.info, parts: message.parts }) : null;
              const userSnippet = isUser ? deriveUserSnippet(message.parts) : '';
              const previewTime = formatMessagePreviewTime(messageCreatedAt, timeFormatPreference);
              // Keep token/time columns stable; the message label owns all
              // remaining space and truncates before it can push metrics.
              const assistantLeft = partsLabel || '\u2014';
              const assistantMiddle = tokens
                ? formatAssistantTokens(tokens.input, tokens.output, formatNumber)
                : '';
              const otherLeft = role || 'unknown';
              const otherLabel = partsLabel ? `${otherLeft}: ${partsLabel}` : otherLeft;

              const jsonValue = isExpanded
                ? JSON.stringify({ info: message.info, parts: message.parts }, null, 2)
                : '';

              return (
                <div
                  key={message.info.id}
                  className="overflow-hidden rounded-lg bg-[var(--surface-elevated)]/70"
                >
                  <button
                    type="button"
                    className="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--interactive-hover)]"
                    aria-expanded={isExpanded}
                    onClick={() => {
                      setExpandedRawMessages((prev) => ({
                        ...prev,
                        [message.info.id]: !(prev[message.info.id] === true),
                      }));
                    }}
                  >
                    <div
                      className="grid items-center gap-x-2 whitespace-nowrap typography-micro"
                      style={{ gridTemplateColumns: isAssistant ? 'minmax(0, 1fr) 7.5rem max-content' : 'minmax(0, 1fr) max-content' }}
                    >
                      {isUser ? (
                        <span
                          className="min-w-0 truncate text-muted-foreground"
                        >
                          <span className="typography-ui-label text-foreground">user:</span>{' '}
                          {userSnippet}
                        </span>
                      ) : (
                        <>
                          <span
                            className={
                              isAssistant
                                ? 'min-w-0 truncate text-muted-foreground'
                                : 'min-w-0 truncate text-muted-foreground'
                            }
                          >
                            {isAssistant ? assistantLeft : otherLabel}
                          </span>
                          {isAssistant && (
                            <span className="text-right text-muted-foreground tabular-nums">
                              {assistantMiddle}
                            </span>
                          )}
                        </>
                      )}
                      <span className="text-right text-muted-foreground">{previewTime}</span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-[var(--surface-subtle)] p-0">
                      <div className="group relative max-h-[26rem] w-full overflow-auto bg-[var(--surface-background)]">
                        <div className="absolute top-1 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCopyRawMessage(message.info.id, jsonValue);
                            }}
                            aria-label={isCopied ? "Copied" : "Copy JSON"}
                            title={isCopied ? "Copied" : "Copy"}
                          >
                            {isCopied ? <Icon name="check" className="size-3.5" /> : <Icon name="file-copy" className="size-3.5" />}
                          </button>
                        </div>
                        <WorkerHighlightedCode
                          language="json"
                          code={jsonValue}
                          style={{
                            margin: 0,
                            padding: '0.75rem',
                            background: 'transparent',
                            fontSize: 'var(--text-micro)',
                            lineHeight: '1.35',
                          }}
                          wrap
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
