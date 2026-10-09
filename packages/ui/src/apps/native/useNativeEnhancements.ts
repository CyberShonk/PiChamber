import { useEffect } from 'react';
import { useNativePreferences } from './preferences';
import { startNativeAttentionTracking } from './attention';

export const useNativeEnhancements = (enabled: boolean): void => {
  const preferences = useNativePreferences();
  useEffect(() => {
    if (!enabled) return;
    document.documentElement.classList.toggle('oc-native-reduce-motion', preferences.reduceMotion);
    return () => document.documentElement.classList.remove('oc-native-reduce-motion');
  }, [enabled, preferences.reduceMotion]);
  useEffect(() => enabled ? startNativeAttentionTracking() : undefined, [enabled]);
};
