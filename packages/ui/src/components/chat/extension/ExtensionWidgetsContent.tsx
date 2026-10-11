import { AnsiText } from '@/components/chat/AnsiText';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
export type ExtensionWidgetEntry = [string, { lines: string[]; placement: 'aboveEditor' | 'belowEditor' }];
/** Shared widget presentation. Live subscription and event ownership belong to the host. */
export const ExtensionWidgetsContent = ({ widgets, collapsedWidgets, onToggle, companion = false, className }: {
  widgets: ExtensionWidgetEntry[]; collapsedWidgets: Record<string, boolean>; onToggle?: (key: string) => void; companion?: boolean; className?: string;
}) => widgets.length === 0 ? (
  <div className={cn('flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center', className)} data-testid="extensions-surface-empty">
    <Icon name="plug-2" aria-hidden="true" className="size-6 text-muted-foreground/60" />
    <p className="typography-ui-label font-medium text-foreground">No extension widgets yet</p>
    <p className="max-w-60 typography-micro text-muted-foreground">Widgets that extensions set with ctx.ui.setWidget show up here.</p>
  </div>
) : (
  <div className={cn('flex h-full min-h-0 flex-col overflow-y-auto', className)} data-testid="extensions-surface" data-scroll={companion ? 'widgets' : undefined}>
    <section aria-label="Widgets">
      <p className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 typography-micro font-medium text-muted-foreground">Widgets<span className="tabular-nums text-muted-foreground/70">{widgets.length}</span></p>
      <div className="flex flex-col p-1 pt-0.5">{widgets.map(([key, widget], index) => {
        const collapsed = Boolean(collapsedWidgets[key]);
        const title = key.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (char) => char.toUpperCase()) || key;
        return <div key={key} data-testid={`extension-widget-${key}`}>
          <button type="button" onClick={onToggle ? () => onToggle(key) : undefined} aria-expanded={!collapsed}
            data-caction={companion ? 'widget' : undefined} data-index={companion ? index : undefined}
            className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-interactive-hover">
            <span className="inline-flex w-4 shrink-0 items-center justify-center"><Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} aria-hidden="true" className="size-3.5 text-muted-foreground" /></span>
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={title}>{title}</span>
            <span className="shrink-0 whitespace-nowrap typography-micro text-muted-foreground">{widget.placement === 'belowEditor' ? 'below editor' : 'above editor'}</span>
          </button>
          {!collapsed && <div className="pb-2 pl-8 pr-2 pt-0.5"><div className="max-h-64 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono typography-micro leading-relaxed text-foreground" data-scroll={companion ? `widget-${index}` : undefined}>{widget.lines.map((line, lineIndex) => <span key={lineIndex} className="block whitespace-pre-wrap"><AnsiText text={line} /></span>)}</div></div>}
        </div>;
      })}</div>
    </section>
  </div>
);
