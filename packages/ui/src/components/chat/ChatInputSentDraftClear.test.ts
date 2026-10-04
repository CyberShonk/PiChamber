import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring coverage for the remount-safe successful-send clear.
 *
 * The sending `ChatInput` can unmount mid-send (the busy flip swaps the
 * transcript branch to a fresh instance), so its own `setMessage("")` is a
 * no-op. The sender must publish a one-shot `sentDraftClear` signal after
 * persisting the cleared draft, and a mounted owner must consume it with an
 * exact text match. Static source assertions extend the store-level behavior
 * tests without a DOM harness (the package has no DOM test environment) and
 * use no module mocks.
 */

const source = readFileSync(join(__dirname, 'ChatInput.tsx'), 'utf8');

const successPublish = 'publishSentDraftClear(sentDraftKey, inputSnapshot.message)';

test('successful send publishes the remount-safe clear signal', () => {
  const thenAt = source.indexOf('await sendPromise');
  const publishAt = source.indexOf(successPublish);
  const catchAt = source.indexOf('.catch((error: unknown)');

  expect(thenAt).toBeGreaterThan(-1);
  expect(publishAt).toBeGreaterThan(thenAt);
  // Success only: the failure handler must not publish.
  expect(catchAt).toBeGreaterThan(publishAt);
});

test('the signal is published from exactly one site', () => {
  expect(source.split('publishSentDraftClear').length - 1).toBe(1);
});

test('the signal is published after the cleared draft is persisted', () => {
  const publishAt = source.indexOf(successPublish);
  // The success path persists the cleared draft before publishing so a
  // consumer that mounts between the two still converges on empty.
  const persistClearedAt = source.lastIndexOf('persistDraftImmediately(', publishAt);
  expect(persistClearedAt).toBeGreaterThan(-1);
  expect(persistClearedAt).toBeLessThan(publishAt);
});

test('a mounted owner consumes the signal with an exact text match', () => {
  expect(source).toContain('const sentDraftClear = useInputStore((s) => s.sentDraftClear);');

  const effectAt = source.indexOf('Remount-safe successful-send clear.');
  expect(effectAt).toBeGreaterThan(-1);
  const effect = source.slice(effectAt, source.indexOf('}, [sentDraftClear', effectAt));

  // One-shot: the owner drops the exact signal it observed.
  expect(effect).toContain('useInputStore.getState().consumeSentDraftClear(sentDraftClear.nonce);');
  // Exact-match contract: edited or retyped-different text is never wiped.
  expect(effect).toContain('shouldApplySentDraftClear(sentDraftClear, myKey, current)');
  // The clear reuses the existing path so the debounced draft write cannot
  // re-persist the sent text.
  expect(effect).toContain('setMessage("");');
});

test('a signal for a different draft key is ignored, never consumed', () => {
  const effectAt = source.indexOf('Remount-safe successful-send clear.');
  const effect = source.slice(effectAt, source.indexOf('}, [sentDraftClear', effectAt));

  expect(effect).toContain('sentDraftClear.draftKey !== myKey');
});

test('the failure path publishes nothing and keeps text and attachments', () => {
  const catchAt = source.indexOf('.catch((error: unknown)');
  expect(catchAt).toBeGreaterThan(-1);
  const failure = source.slice(catchAt);

  expect(failure).not.toContain('publishSentDraftClear');
  expect(failure).not.toContain('consumeSentDraftClear');
  // Failure keeps attachments for retry: nothing detaches after the send.
  expect(failure).not.toContain('detachAttachedFiles(');
  // Failure restores the sent text for editing.
  expect(failure).toContain('setMessage(inputSnapshot.message);');
});

test('success still detaches the sent attachments before publishing', () => {
  const detachAt = source.indexOf('detachAttachedFiles(composerAttachmentIds)');
  const publishAt = source.indexOf(successPublish);

  expect(detachAt).toBeGreaterThan(-1);
  expect(detachAt).toBeLessThan(publishAt);
});
