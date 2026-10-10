import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SidebarHeader } from './SidebarHeader';

const render = (mobileVariant: boolean, isSessionSearchOpen = false, query = '', nativeAppVariant = mobileVariant) => renderToStaticMarkup(
  <TooltipProvider>
    <SidebarHeader
      hideDirectoryControls={false}
      handleOpenDirectoryDialog={() => {}}
      onOpenArchive={() => {}}
      onClose={() => {}}
      headerActionIconClass="size-4"
      headerActionButtonClass="size-9"
      isSessionSearchOpen={isSessionSearchOpen}
      setIsSessionSearchOpen={() => {}}
      sessionSearchInputRef={{ current: null }}
      sessionSearchQuery={query}
      setSessionSearchQuery={() => {}}
      hasSessionSearchQuery={Boolean(query)}
      searchMatchCount={2}
      selectionModeEnabled={false}
      onToggleSelectionMode={() => {}}
      mobileVariant={mobileVariant}
      nativeAppVariant={nativeAppVariant}
    />
  </TooltipProvider>,
);

describe('session sidebar header', () => {
  test('hosted phone retains its search toggle and original input attributes', () => {
    const closed = render(true, false, '', false);
    expect(closed).not.toContain('<input');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('Close sessions');
    const open = render(true, true, '', false);
    expect(open).toContain('<input');
    expect(open).not.toContain('autoCapitalize');
    expect(open).not.toContain('autoCorrect');
    expect(open.match(/<input[^>]*>/)?.[0]).not.toContain('aria-label="Search sessions"');
    expect(open).not.toContain('pr-10');
  });
  test('native search starts collapsed and exposes a header toggle', () => {
    const closed = render(true);
    expect(closed).not.toContain('<input');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-label="Search sessions"');
    expect(closed).toContain('aria-label="Close sessions"');
    const open = render(true, true);
    expect(open).toContain('<input');
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain('autofocus');
  });
  test('desktop retains the search toggle and only mounts its field while open', () => {
    expect(render(false)).not.toContain('<input');
    expect(render(false)).toContain('aria-expanded="false"');
    expect(render(false, true)).toContain('<input');
    expect(render(false, true)).not.toContain('aria-label="Close sessions"');
  });
  test('phone queries retain the clear action and explicit match count', () => {
    const markup = render(true, true, 'certificate');
    expect(markup).toContain('value="certificate"');
    expect(markup).toContain('aria-label="Clear search"');
    expect(markup).toContain('2 matches');
  });
});
