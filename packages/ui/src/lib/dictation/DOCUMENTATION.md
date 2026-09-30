# Dictation client module

## Purpose

This directory owns the composer dictation client: audio capture
(`audio-capture.ts`, `audio-worklet.ts`), the transcription socket client
(`dictation-client.ts`), client state (`dictation-state.ts`), the composer hook
(`use-composer-dictation.ts`), and the shared transcription-status reader
(`stt-status.ts`).

## Status read contract (`stt-status.ts`)

`fetchSttStatus()` is the single reader for `GET /api/stt/status`, shared by
the composer hook (which refreshes on every `ChatInput` mount) and Dictation
settings, so app startup issues the request once instead of once per consumer.

- Concurrent callers share the in-flight promise; settled successes memoize by
  `getRuntimeKey()` for 30 s. Dictation availability does not change at
  sub-minute cadence outside explicit user action.
- Failure or a non-OK response throws and never populates the memo, so the
  next caller retries against the network.
- `resetSttStatusCache()` clears both entries and runs through the central
  runtime-endpoint reset, so a runtime switch can never serve the previous
  host's status.
- `{ fresh: true }` bypasses both entries and never replaces the memo.
  Settings passes it after install/download actions and for its
  download-progress poll, where a memoized snapshot would freeze progress
  output. Mount and background reads use the memoized path.

## Failure semantics

A failed status read is never cached as "dictation unavailable". The composer
hook treats a failed refresh as no signal (availability stays `false` until a
successful read), and settings surfaces the thrown error without clearing
previously rendered state.
