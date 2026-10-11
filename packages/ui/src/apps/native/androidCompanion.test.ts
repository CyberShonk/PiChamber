import { expect, test } from 'bun:test';
import { createCompanionPublisher } from './androidCompanion';
import type { CompanionFrame } from './companionDocument';
const frame = (scope: number): CompanionFrame => ({ scope, workspaceScope: 1, document: '', html: String(scope), background: '#070809' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
test('publisher coalesces latest frame and keeps a single native send in flight', async () => {
  const sent: number[] = []; let complete: (() => void) | undefined;
  const publisher = createCompanionPublisher(async (value) => { sent.push(value.scope); await new Promise<void>((resolve) => { complete = resolve; }); }, () => {}, 1);
  publisher.update(frame(1)); publisher.update(frame(2)); await tick();
  expect(sent).toEqual([2]); publisher.update(frame(3)); publisher.update(frame(4)); await tick();
  expect(sent).toEqual([2]); complete!(); await tick(); expect(sent).toEqual([2, 4]);
  complete!(); publisher.dispose();
});
test('disposing cancels pending sends and suppresses late failure callbacks', async () => {
  let sends = 0; let errors = 0; let reject: ((error: Error) => void) | undefined;
  const pending = createCompanionPublisher(async () => { sends++; }, () => { errors++; }, 1);
  pending.update(frame(1)); pending.dispose(); await tick(); expect(sends).toBe(0);
  const flight = createCompanionPublisher(() => new Promise<void>((_, fail) => { reject = fail; }), () => { errors++; }, 1);
  flight.update(frame(2)); await tick(); flight.dispose(); reject!(new Error('late')); await tick(); expect(errors).toBe(0);
});
