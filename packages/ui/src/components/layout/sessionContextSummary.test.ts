import { expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/chat/types';
import { summarizeSessionContext } from './sessionContextSummary';
const entry = (info: object) => ({ info: info as Message, parts: [] as Part[] });
const providers = [{ id: 'local', name: 'Local', models: [{ id: 'model', name: 'Model', limit: { context: 1000 } }] }];

test('context uses latest reported input including cache, excludes output and ignores a streaming empty tail', () => {
  const summary = summarizeSessionContext([
    entry({ role: 'user' }), entry({ role: 'assistant', usage: { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 }, cost: 0.1 }),
    entry({ role: 'assistant', usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5 }, cost: 0.2, model: { providerID: 'local', modelID: 'model' } }),
    entry({ role: 'assistant' }),
  ], providers);
  expect(summary.contextWindowTokens).toBe(130); expect(summary.usagePercent).toBe(13);
  expect(summary.providerModel.modelName).toBe('Model');
  expect(summary.messagesCount).toBe(4); expect(summary.userMessagesCount).toBe(1); expect(summary.assistantMessagesCount).toBe(3);
  expect(Math.abs(summary.totalAssistantCost - 0.3)).toBeLessThan(1e-10);
});

test('unknown limits and missing usage are unavailable, not a fabricated capacity', () => {
  const summary = summarizeSessionContext([entry({ role: 'assistant', cost: Number.NaN })], []);
  expect(summary.hasUsage).toBe(false); expect(summary.contextLimit).toBeNull(); expect(summary.totalAssistantCost).toBe(0);
});

test('legacy usage stays compatible with the main panel', () => {
  const summary = summarizeSessionContext([entry({ role: 'assistant', tokens: { input: 1, output: 2, cache: { read: 3, write: 4 } } })], []);
  expect(summary.contextWindowTokens).toBe(10); expect(summary.hasUsage).toBe(true);
});
