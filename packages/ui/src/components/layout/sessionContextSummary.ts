import type { Message, Part } from '@/lib/chat/types';
import { deriveMessageRole } from '@/components/chat/message/messageRole';
import { computeCacheHitRate, computePiContextWindowTokens, extractSessionMessageBreakdown, type PiUsageLike } from '@/stores/utils/tokenUtils';

type Provider = { id?: string; name?: string; models?: Array<{ id?: string; name?: string; limit?: { context?: number } }> };
const nonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Same authoritative usage contract for the primary Context panel and companion.
 * Only usage metadata is read (including legacy part tokens), never transcript text. */
export const summarizeSessionContext = (messages: ReadonlyArray<{ info: Message; parts: Part[] }>, providers: readonly Provider[]) => {
  let userMessagesCount = 0, assistantMessagesCount = 0, totalAssistantCost = 0;
  let contextMessage: (typeof messages)[number] | undefined;
  for (const message of messages) {
    const role = deriveMessageRole(message.info);
    if (role.isUser) userMessagesCount++;
    if (role.role !== 'assistant') continue;
    assistantMessagesCount++;
    totalAssistantCost += nonNegative((message.info as { cost?: unknown }).cost);
    if (extractSessionMessageBreakdown(message).total > 0) contextMessage = message;
  }
  const tokenBreakdown = contextMessage ? extractSessionMessageBreakdown(contextMessage) :
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const contextUsage = (contextMessage?.info as { usage?: PiUsageLike } | undefined)?.usage;
  const latestModel = contextMessage?.info.model as { providerID?: string; modelID?: string } | undefined;
  const provider = providers.find((entry) => entry.id === latestModel?.providerID);
  const model = provider?.models?.find((entry) => entry.id === latestModel?.modelID);
  const contextLimit = nonNegative(model?.limit?.context) || null;
  const contextWindowTokens = contextUsage ? computePiContextWindowTokens(contextUsage) : tokenBreakdown.total;
  return {
    messagesCount: messages.length, userMessagesCount, assistantMessagesCount, totalAssistantCost,
    tokenBreakdown, contextUsage, contextLimit, contextWindowTokens,
    usagePercent: contextLimit ? Math.min(999, contextWindowTokens / contextLimit * 100) : 0,
    cacheHitRate: computeCacheHitRate({ input: tokenBreakdown.input, cache: { read: tokenBreakdown.cacheRead, write: tokenBreakdown.cacheWrite } }),
    providerModel: { providerName: provider?.name || latestModel?.providerID || '-', modelName: model?.name || latestModel?.modelID || '-', contextLimit },
    hasUsage: Boolean(contextMessage),
  };
};
