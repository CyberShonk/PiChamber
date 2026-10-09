import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { NATIVE_THEMES } from './themes';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let values: Map<string, string>;
const Probe = () => { const context = useThemeSystem(); return <span>{context.currentTheme.metadata.id}:{context.themeMode}:{context.availableThemes.some((theme) => theme.metadata.id === 'red-carbon-dark') ? 'red-carbon' : 'ordinary'}</span>; };
const render = (native: boolean) => renderToStaticMarkup(<ThemeSystemProvider additionalThemes={native ? NATIVE_THEMES : undefined} defaultThemeId={native ? 'red-carbon-dark' : undefined} localPreferencesOnly={native}><Probe /></ThemeSystemProvider>);

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
});
afterEach(() => {
  for (const [key, descriptor] of [['window', originalWindow], ['localStorage', originalStorage]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
describe('device-local theme opt-in', () => {
  test('fresh native installs use Red Carbon even when iOS currently prefers light', () => expect(render(true)).toContain('red-carbon-dark:dark:red-carbon'));
  test('native devices retain an explicitly selected existing theme', () => {
    values.set('pichamber.native.darkThemeId', 'pichamber-dark'); values.set('pichamber.native.themeMode', 'dark');
    expect(render(true)).toContain('pichamber-dark:dark:red-carbon');
  });
  test('host appearance preferences do not overwrite the native choice', () => {
    values.set('themeMode', 'light'); values.set('darkThemeId', 'pichamber-dark');
    expect(render(true)).toContain('red-carbon-dark:dark:red-carbon');
  });
  test('hosted browser appearance retains its defaults and no native preset', () => {
    values.set('themeMode', 'light');
    expect(render(false)).toContain('pichamber-light:light:ordinary');
  });
});
