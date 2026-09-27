// Keyed async resource: SWR settle notification, coalescing, staleness, failure-keeps-data.
import { describe, expect, test } from 'bun:test';
import { createKeyedAsyncResource } from './githubAsyncResource';

describe('githubAsyncResource', () => {
  test('notifies onSettle when a background revalidation of cached data settles', async () => {
    // Regression: ensure() on a cached entry resolves immediately and flips
    // isLoading in the background; without a settle notification the view
    // kept rendering isLoading forever (Closed -> Open loads forever).
    const settled: string[] = [];
    const resource = createKeyedAsyncResource<string[]>({ onSettle: (key) => settled.push(key) });
    await resource.refresh('open', async () => []);
    expect(settled).toEqual(['open']);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cached = await resource.ensure('open', async () => {
      await gate;
      return [];
    });
    // Last-known data is served synchronously while the fresh read runs behind it.
    expect(cached.data).toEqual([]);
    expect(resource.getEntry('open')?.isLoading).toBe(true);
    expect(settled).toEqual(['open']);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resource.getEntry('open')?.isLoading).toBe(false);
    expect(settled).toEqual(['open', 'open']);
  });

  test('coalesces in-flight loads for the same key', async () => {
    const resource = createKeyedAsyncResource<{ n: number }>();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { n: calls };
    };
    const [a, b] = await Promise.all([resource.refresh('k1', loader), resource.refresh('k1', loader)]);
    expect(calls).toBe(1);
    expect(a.data).toEqual({ n: 1 });
    expect(b.data).toEqual({ n: 1 });
  });

  test('stale completions never overwrite newer state', async () => {
    const resource = createKeyedAsyncResource<string>();
    let releaseSlow!: (value: string) => void;
    const slowGate = new Promise<string>((resolve) => { releaseSlow = resolve; });
    const slow = resource.refresh('k', async () => {
      const value = await slowGate;
      return value;
    });
    // Invalidate bumps the generation while the slow load is in flight;
    // the replacement load wins the race.
    await resource.invalidate('k');
    const fast = await resource.refresh('k', async () => 'new');
    expect(fast.data).toBe('new');
    releaseSlow('old');
    const settled = await slow;
    // The stale completion returns current state, not its own outdated value.
    expect(settled.data).toBe('new');
    expect(resource.getEntry('k')?.data).toBe('new');
  });

  test('failed refresh keeps previous data marked stale with error', async () => {
    const resource = createKeyedAsyncResource<string>();
    await resource.refresh('k', async () => 'good');
    const next = await resource.refresh('k', async () => {
      throw { body: { kind: 'failed', message: 'boom' } };
    });
    // Failure is not empty success: last-known data stays with a stale flag.
    expect(next.data).toBe('good');
    expect(next.stale).toBe(true);
    expect(next.error).toEqual({ kind: 'failed', message: 'boom' });
    expect(resource.getEntry('k')?.data).toBe('good');
  });
});
