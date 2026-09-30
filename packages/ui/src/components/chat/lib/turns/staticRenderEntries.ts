import type { ChatMessageEntry, TurnRecord } from './types';

export type RenderEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'history-gate'; key: string; turns: TurnRecord[] }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean; nextEntryFirstMessage?: ChatMessageEntry };

export const EMPTY_RENDER_ENTRIES: RenderEntry[] = [];

type BuildStaticRenderEntriesOptions = {
    /** Every turn except the last, which renders as the streaming tail. */
    staticTurns: TurnRecord[];
    /** Display-ordered messages; only needed when ungrouped messages exist. */
    messages: ChatMessageEntry[];
    ungroupedMessageIds: ReadonlySet<string>;
    lastTurnId: string | null | undefined;
    /** User message id of the tail turn, when there is one. */
    tailUserMessageId: string | undefined;
};

/**
 * Order static history entries and split off ungrouped messages that belong
 * after the streaming tail.
 *
 * The last turn always renders as the streaming tail, after every static
 * entry. Ungrouped messages (extension notes and cards) that follow the tail
 * turn's user message therefore go to `trailing`, rendered after the tail,
 * instead of landing above it. With no turns at all, the last ungrouped
 * message is itself the tail, so it is left out of the static list to render
 * once.
 */
export const buildStaticRenderEntries = ({
    staticTurns,
    messages,
    ungroupedMessageIds,
    lastTurnId,
    tailUserMessageId,
}: BuildStaticRenderEntriesOptions): { entries: RenderEntry[]; trailing: RenderEntry[] } => {
    const turnEntries = staticTurns.map((turn) => ({
        kind: 'turn' as const,
        key: `turn:${turn.turnId}`,
        turn,
        isLastTurn: turn.turnId === lastTurnId,
    }));

    if (ungroupedMessageIds.size === 0) {
        return { entries: turnEntries, trailing: EMPTY_RENDER_ENTRIES };
    }

    const turnEntryByUserMessageId = new Map<string, RenderEntry>();
    turnEntries.forEach((entry) => {
        turnEntryByUserMessageId.set(entry.turn.userMessage.info.id, entry);
    });

    const lastMessage = messages[messages.length - 1];
    const tailUngroupedId = !tailUserMessageId && lastMessage && ungroupedMessageIds.has(lastMessage.info.id)
        ? lastMessage.info.id
        : undefined;

    const entries: RenderEntry[] = [];
    const trailing: RenderEntry[] = [];
    let afterTailTurn = false;
    messages.forEach((message, index) => {
        if (tailUserMessageId && message.info.id === tailUserMessageId) {
            afterTailTurn = true;
            return;
        }
        const turnEntry = turnEntryByUserMessageId.get(message.info.id);
        if (turnEntry) {
            entries.push(turnEntry);
            return;
        }
        if (!ungroupedMessageIds.has(message.info.id) || message.info.id === tailUngroupedId) {
            return;
        }
        (afterTailTurn ? trailing : entries).push({
            kind: 'ungrouped',
            key: `msg:${message.info.id}`,
            message,
            previousMessage: index > 0 ? messages[index - 1] : undefined,
            nextMessage: index < messages.length - 1 ? messages[index + 1] : undefined,
        });
    });

    return { entries, trailing: trailing.length > 0 ? trailing : EMPTY_RENDER_ENTRIES };
};
