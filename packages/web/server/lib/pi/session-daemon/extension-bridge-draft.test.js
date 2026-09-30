import { describe, expect, it } from 'vitest';

import { createExtensionBridge } from './extension-bridge.js';

// Direct bridge coverage for the getEditorText() draft mirror lifecycle edges
// that the socket-level daemon tests cannot reach (disposal, untracked reset).
const createBridge = () => {
  const published = [];
  const bridge = createExtensionBridge({
    publish: (event, payload, sessionId) => published.push({ event, payload, sessionId }),
    resolveDirectory: async (directory) => directory,
    redactAttachmentPaths: (value) => value,
    redactAttachmentValues: (value) => value,
    findRuntimeBySessionId: () => undefined,
    getDefaultDirectory: () => '/repo',
    getSequence: () => 0,
    protocolError: (code, message) => Object.assign(new Error(message), { code }),
    requestSessionShutdown: () => {},
  });
  const session = { sessionId: 's1' };
  const ui = bridge.buildExtensionBindings(session).uiContext;
  return { bridge, ui, published };
};

const trackEvents = (published) => published.filter((entry) => entry.event === 'extension.editor.track');

describe('extension bridge draft mirror', () => {
  it('disables browser sync when session extension state is cleared', () => {
    const { bridge, ui, published } = createBridge();
    ui.getEditorText();
    expect(bridge.updateExtensionDraft('s1', 'typed', 1)).toEqual({ accepted: true });

    bridge.clearExtensionState('s1');

    expect(trackEvents(published).map((entry) => entry.payload)).toEqual([{ enabled: true }, { enabled: false }]);
    expect(bridge.getSnapshotState('s1').draftTracked).toBeUndefined();
    expect(bridge.updateExtensionDraft('s1', 'late', 2)).toEqual({ accepted: false });
    expect(ui.getEditorText()).toBe('');
    // A later call opts the session back in.
    expect(trackEvents(published).at(-1).payload).toEqual({ enabled: true });
  });

  it('does not publish a disable event for sessions that never tracked', () => {
    const { bridge, published } = createBridge();
    bridge.clearExtensionState('s1');
    expect(trackEvents(published)).toEqual([]);
  });

  it('prompt reset does not allocate draft state for untracked sessions', () => {
    const { bridge, ui, published } = createBridge();
    bridge.resetExtensionDraft('s1');
    expect(ui.getEditorText()).toBe('');
    expect(bridge.getSnapshotState('s1')).toEqual({ draftTracked: true });
    expect(trackEvents(published)).toHaveLength(1);
  });
});
