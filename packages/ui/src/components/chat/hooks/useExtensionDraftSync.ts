import * as React from 'react';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { piClient } from '@/lib/pi/client';

export interface UseExtensionDraftSyncOptions {
  sessionId?: string | null;
  directory?: string | null;
  text: string;
  debounceMs?: number;
}

let globalDraftRevision = Date.now();
const allocateDraftRevision = (): number => {
  globalDraftRevision = Math.max(globalDraftRevision + 1, Date.now());
  return globalDraftRevision;
};

const isDocumentActive = (): boolean => {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  return true;
};

export function useExtensionDraftSync({
  sessionId,
  directory,
  text,
  debounceMs = 250,
}: UseExtensionDraftSyncOptions): void {
  const isDraftTracked = usePiSessionSnapshot(
    (state) => {
      if (!sessionId) return false;
      return state.reducer.bySession.get(sessionId)?.extensionDraftTracked === true;
    },
    Object.is,
    sessionId ? `session:${sessionId}` : 'chrome',
  );

  // Untracked sessions (the common case) must not re-run the effect per
  // keystroke: the effect only sees the text while tracking is on.
  const trackedText = isDraftTracked ? text : null;

  const textRef = React.useRef(text);
  textRef.current = text;

  const directoryRef = React.useRef(directory);
  directoryRef.current = directory;

  const sessionIdRef = React.useRef(sessionId);
  sessionIdRef.current = sessionId;

  const lastSentTextBySessionRef = React.useRef<Map<string, string>>(new Map());
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackedSessionsRef = React.useRef<Set<string>>(new Set());

  const sendDraft = React.useCallback((targetSessionId: string, textToSend: string) => {
    if (!isDocumentActive()) return;
    lastSentTextBySessionRef.current.set(targetSessionId, textToSend);
    const revision = allocateDraftRevision();
    const dir = directoryRef.current;
    piClient
      .updateExtensionDraft({
        sessionId: targetSessionId,
        text: textToSend,
        revision,
        ...(dir ? { directory: dir } : {}),
      })
      .catch(() => {
        // Request errors are ignored; text is never logged.
      });
  }, []);

  React.useEffect(() => {
    if (!sessionId || trackedText === null) {
      if (sessionId) {
        trackedSessionsRef.current.delete(sessionId);
      }
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const becameTracked = !trackedSessionsRef.current.has(sessionId);
    if (becameTracked) {
      trackedSessionsRef.current.add(sessionId);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      sendDraft(sessionId, trackedText);
      return;
    }

    const lastSent = lastSentTextBySessionRef.current.get(sessionId);
    if (trackedText === lastSent) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const currentText = textRef.current;
      const currentSession = sessionIdRef.current;
      if (!currentSession || currentText === lastSentTextBySessionRef.current.get(currentSession)) {
        return;
      }
      sendDraft(currentSession, currentText);
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [sessionId, trackedText, debounceMs, sendDraft]);
}
