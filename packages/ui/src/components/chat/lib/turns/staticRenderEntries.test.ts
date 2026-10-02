import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@/lib/chat/types';

import { buildStaticRenderEntries, EMPTY_RENDER_ENTRIES } from './staticRenderEntries';
import type { ChatMessageEntry, TurnRecord } from './types';

const message = (id: string, role: string): ChatMessageEntry => ({
    info: { id, role, sessionID: 's1', time: { created: 1 } } as unknown as Message,
    parts: [] as Part[],
});

const turn = (user: ChatMessageEntry): TurnRecord => ({
    turnId: user.info.id,
    userMessage: user,
} as unknown as TurnRecord);

const keys = (entries: { key: string }[]) => entries.map((entry) => entry.key);

describe('buildStaticRenderEntries', () => {
    test('an extension message after the only (tail) turn renders after the tail, not at the top', () => {
        const u1 = message('u1', 'user');
        const messages = [u1, message('a1', 'assistant'), message('x1', 'extension')];

        const result = buildStaticRenderEntries({
            staticTurns: [],
            messages,
            ungroupedMessageIds: new Set(['x1']),
            lastTurnId: 'u1',
            tailUserMessageId: 'u1',
        });

        expect(keys(result.entries)).toEqual([]);
        expect(keys(result.trailing)).toEqual(['msg:x1']);
    });

    test('messages between static turns stay in order; messages after the tail turn trail it', () => {
        const u1 = message('u1', 'user');
        const u2 = message('u2', 'user');
        const messages = [u1, message('a1', 'assistant'), message('x1', 'extension'), u2, message('a2', 'assistant'), message('x2', 'extension')];

        const result = buildStaticRenderEntries({
            staticTurns: [turn(u1)],
            messages,
            ungroupedMessageIds: new Set(['x1', 'x2']),
            lastTurnId: 'u2',
            tailUserMessageId: 'u2',
        });

        expect(keys(result.entries)).toEqual(['turn:u1', 'msg:x1']);
        expect(keys(result.trailing)).toEqual(['msg:x2']);
    });

    test('with no turns the last ungrouped message is the tail and is not duplicated in the static list', () => {
        const messages = [message('x1', 'extension'), message('x2', 'extension')];

        const result = buildStaticRenderEntries({
            staticTurns: [],
            messages,
            ungroupedMessageIds: new Set(['x1', 'x2']),
            lastTurnId: null,
            tailUserMessageId: undefined,
        });

        expect(keys(result.entries)).toEqual(['msg:x1']);
        expect(result.trailing).toBe(EMPTY_RENDER_ENTRIES);
    });

    test('without ungrouped messages only static turn entries are returned', () => {
        const u1 = message('u1', 'user');

        const result = buildStaticRenderEntries({
            staticTurns: [turn(u1)],
            messages: [],
            ungroupedMessageIds: new Set(),
            lastTurnId: 'u2',
            tailUserMessageId: 'u2',
        });

        expect(keys(result.entries)).toEqual(['turn:u1']);
        expect(result.trailing).toBe(EMPTY_RENDER_ENTRIES);
    });
});
