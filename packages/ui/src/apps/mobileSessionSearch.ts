import type { SwitcherItem } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';

/** Search the already ordered recent catalog without changing selection or fetching. */
export const filterMobileRecentSessions = (items: readonly SwitcherItem[], query: string): readonly SwitcherItem[] => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items.filter((item) => {
    const text = [getSessionDisplayTitle(item.node.session, 'Untitled session'), item.secondaryMeta.projectLabel, item.secondaryMeta.branchLabel, item.groupDirectory]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
};
