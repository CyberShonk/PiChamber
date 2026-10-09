export type OfflineCopy = { id: string; runtimeKey: string; sessionId: string; title: string; host: string; savedAt: number; text: string };
const MAX_OFFLINE_COPY_BYTES = 600_000;
const encoder = new TextEncoder();
/** Bound complete UTF-8 payloads, including metadata, rather than JavaScript string length. */
export const isValidOfflineCopy = (value: unknown): value is OfflineCopy => {
  if (!value || typeof value !== 'object') return false;
  const copy = value as OfflineCopy;
  if (!['id', 'runtimeKey', 'sessionId', 'title', 'host', 'text'].every((key) => typeof copy[key as keyof OfflineCopy] === 'string') || !copy.id || !copy.runtimeKey || !copy.sessionId || !Number.isFinite(copy.savedAt)) return false;
  const payload = { id: copy.id, runtimeKey: copy.runtimeKey, sessionId: copy.sessionId, title: copy.title, host: copy.host, savedAt: copy.savedAt, text: copy.text };
  return encoder.encode(JSON.stringify(payload)).length <= MAX_OFFLINE_COPY_BYTES;
};
