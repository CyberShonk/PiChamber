import React from 'react';
import {
  type TimelineBoundaries,
  type TimelineWeekStart,
  getTimelineBoundaries,
  getNextLocalMidnight,
} from '../timelineBuckets';

export const useTimelineBoundaries = (
  enabled: boolean,
  weekStart: TimelineWeekStart,
): TimelineBoundaries | null => {
  const [dayAnchor, setDayAnchor] = React.useState<number>(() => Date.now());

  const boundaries = React.useMemo(() => {
    if (!enabled) return null;
    return getTimelineBoundaries(dayAnchor, weekStart);
  }, [enabled, dayAnchor, weekStart]);

  React.useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;

    const now = Date.now();
    const nextMidnight = getNextLocalMidnight(now);
    const delay = Math.max(50, nextMidnight - now + 50);

    const timer = window.setTimeout(() => {
      setDayAnchor(Date.now());
    }, delay);

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        const currentToday = getTimelineBoundaries(Date.now(), weekStart).startOfToday;
        if (boundaries && currentToday !== boundaries.startOfToday) {
          setDayAnchor(Date.now());
        }
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      window.clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [enabled, dayAnchor, weekStart, boundaries]);

  return boundaries;
};
