import { describe, expect, test } from 'bun:test';
import type { SwitcherItem } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { filterMobileRecentSessions } from './mobileSessionSearch';

const item = (id: string, title: string, projectLabel: string | null, branchLabel: string | null): SwitcherItem => ({
  node: { session: { id, title }, children: [] },
  projectId: projectLabel,
  groupDirectory: `/projects/${projectLabel ?? 'loose'}`,
  secondaryMeta: { projectLabel, branchLabel },
});
const items = [item('b', 'Fix certificate errors', 'PiChamber', 'ios'), item('a', 'Session list layout', 'PiChamber', 'main'), item('c', 'Notes', null, null)];

describe('mobile recent session search', () => {
  test('blank search preserves the authoritative ordering and item identities', () => {
    expect(filterMobileRecentSessions(items, '  ')).toBe(items);
    expect(filterMobileRecentSessions(items, 'pichamber')[0]).toBe(items[0]);
    expect(filterMobileRecentSessions(items, 'pichamber').map((row) => row.node.session.id)).toEqual(['b', 'a']);
  });
  test('all words can match title, project, branch, and directory without case sensitivity', () => {
    expect(filterMobileRecentSessions(items, '  CERTIFICATE IOS  ')).toEqual([items[0]]);
    expect(filterMobileRecentSessions(items, 'projects pichamber main')).toEqual([items[1]]);
    expect(filterMobileRecentSessions(items, 'not-present')).toEqual([]);
  });
  test('search handles sessions without project or branch and uses the visible title fallback', () => {
    expect(filterMobileRecentSessions(items, 'notes')).toEqual([items[2]]);
    const empty = item('empty', '', null, null);
    empty.node.session.messageCount = 0;
    expect(filterMobileRecentSessions([empty], 'first prompt')).toEqual([empty]);
  });
});
