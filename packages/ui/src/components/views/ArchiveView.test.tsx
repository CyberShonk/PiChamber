import { expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
let nativeApp = true;
const session = { id: 'archived', title: 'An archived conversation', directory: '/repo', time: { archived: 100, updated: 100, created: 100 } };
mock.module('@/apps/mobileAppContext', () => ({ useMobileAppActions: () => ({ nativeApp }) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: (select: (state: object) => unknown) => select({ isArchivePageOpen: true, setArchivePageOpen: () => {}, setActiveMainTab: () => {} }) }));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: object) => unknown) => select({ homeDirectory: '/home' }) }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (state: object) => unknown) => select({ setCurrentSession: () => {}, unarchiveSession: async () => true }) }));
mock.module('@/sync/sync-context', () => ({ useCatalogUiSessions: () => [session] }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ComponentProps<'button'>) => <button {...props} /> }));
mock.module('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>, TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>, TooltipContent: () => null }));
mock.module('@base-ui/react/dialog', () => ({ Dialog: {
  Root: ({ children }: React.PropsWithChildren) => <>{children}</>, Portal: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Backdrop: () => null, Popup: (props: React.ComponentProps<'section'>) => <section {...props} />,
  Title: (props: React.ComponentProps<'h2'>) => <h2 {...props} />, Description: (props: React.ComponentProps<'p'>) => <p {...props} />,
  Close: ({ render, children, ...props }: React.ComponentProps<'button'> & { render?: React.ReactElement }) => render ? React.cloneElement(render, props, children) : <button {...props}>{children}</button>,
} }));
const { ArchiveView } = await import('./ArchiveView');
test('native archive reserves safe areas, a close header and phone list width', () => {
  nativeApp = true;
  const html = renderToStaticMarkup(<ArchiveView />);
  expect(html).toContain('var(--oc-safe-area-top');
  expect(html).toContain('env(safe-area-inset-bottom');
  expect(html).toContain('<header');
  expect(html).toContain('Close archived sessions');
  expect(html).toContain('min-h-11 min-w-11');
  expect(html).toContain('max-[640px]:flex-col');
  expect(html).toContain('size-11 shrink-0');
  expect(html).not.toContain('max-[640px]:w-40');
});
test('hosted archive preserves its original dialog presentation', () => {
  nativeApp = false;
  const html = renderToStaticMarkup(<ArchiveView />);
  expect(html).not.toContain('<header');
  expect(html).toContain('max-[640px]:w-40');
  expect(html).not.toContain('var(--oc-safe-area-top');
});
