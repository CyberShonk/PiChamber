import { ExtensionWidgetsContent } from '@/components/chat/extension/ExtensionWidgetsContent';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { companionDiffLines } from './companionDiff';
import type { CompanionTab, CompanionView } from './companionModel';

const destinations: Array<{ tab: CompanionTab; label: string; icon: IconName }> = [
  { tab: 'sessions', label: 'Sessions', icon: 'list-unordered' },
  { tab: 'review', label: 'Changes', icon: 'git-branch' },
  { tab: 'artifacts', label: 'Files', icon: 'file-text' },
  { tab: 'context', label: 'Context', icon: 'donut-chart' },
  { tab: 'extensions', label: 'Extensions', icon: 'plug-2' },
  { tab: 'attention', label: 'Attention', icon: 'notification-3' },
];

const Empty = ({ text }: { text: string }) => (
  <p className="companion-empty typography-ui-label text-muted-foreground">{text}</p>
);

const WorkspaceTabs = ({ view }: { view: CompanionView }) => (
  <header className="companion-toolbar">
    <nav role="tablist" aria-label="Workspace">
      {destinations.map(({ tab, label, icon }) => (
        <Button key={tab} variant="ghost" size="sm" role="tab" aria-label={label}
          aria-selected={view.tab === tab} data-caction="tab" data-tab={tab}>
          <Icon name={icon} className="size-5" />
          {view.tab === tab && <span>{label}</span>}
          {tab === 'attention' && view.questions.length > 0 && (
            <span className="typography-micro">{view.questions.length}</span>
          )}
        </Button>
      ))}
    </nav>
    <Button variant="ghost" size="icon" aria-label="Refresh companion" data-caction="refresh">
      <Icon name="refresh" className="size-4" />
    </Button>
  </header>
);

const SessionBoard = ({ view }: { view: CompanionView }) => (
  <main className="companion-session-board">
    <div className="companion-board-filter">
      <div role="group" aria-label="Session scope" className="companion-scope-switch">
        <Button variant="ghost" size="sm" aria-pressed={!view.projectOnly} data-caction={view.projectOnly ? 'scope' : undefined}>All projects</Button>
        <Button variant="ghost" size="sm" aria-pressed={view.projectOnly === true} data-caction={!view.projectOnly ? 'scope' : undefined}>This workspace</Button>
      </div>
      <span className="typography-micro text-muted-foreground">{view.sessions.length} sessions</span>
    </div>
    <div className="companion-scroll companion-sessions" data-scroll="sessions">
      {view.sessions.length === 0 ? <Empty text="No loaded sessions. Open the sessions list on the top screen." /> : (
        view.sessions.map((session, index) => (
          <Button key={index} variant="ghost" size="default" className="companion-session"
            aria-pressed={session.selected} data-caction="session" data-index={index} disabled={!view.connected}>
            <span className="companion-session-copy">
              <span className="companion-session-title">{session.title}</span>
              <span className="companion-session-meta typography-meta text-muted-foreground">
                <span className="truncate">{session.project}</span>
                {session.unseen ? <span className="companion-unread">{session.unseen} unread</span> : null}
                {session.state !== 'idle' && <span className="companion-status" data-state={session.state}>
                  {session.state === 'busy' ? 'Running' : session.state === 'retry' ? 'Retrying' :
                    session.state === 'error' ? 'Error' : session.state === 'offline' ? 'Offline' : null}
                </span>}
              </span>
            </span>
          </Button>
        ))
      )}
    </div>
  </main>
);

const ContextSummary = ({ view }: { view: CompanionView }) => {
  const summary = view.context;
  if (!summary) return <Empty text="Open a session to inspect context." />;
  const number = (value: number) => value.toLocaleString('en-US');
  const metrics = [
    ['Messages', number(summary.messagesCount)], ['User', number(summary.userMessagesCount)],
    ['Assistant', number(summary.assistantMessagesCount)], ['Cost', summary.totalAssistantCost.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: summary.totalAssistantCost > 0 && summary.totalAssistantCost < 0.01 ? 4 : 2 })],
    ['Cache read', number(summary.tokenBreakdown.cacheRead)], ['Cache write', number(summary.tokenBreakdown.cacheWrite)],
  ];
  return <main className="companion-scroll companion-context-summary" data-scroll="context">
    <p className="typography-meta text-muted-foreground companion-model-name">{summary.providerModel.providerName} / {summary.providerModel.modelName}</p>
    <section className="companion-context-usage">
      <div className="typography-ui-label"><span>Context</span><span>{summary.hasUsage ? number(summary.contextWindowTokens) : 'Awaiting usage'}{summary.contextLimit ? ` / ${number(summary.contextLimit)}` : ''}</span></div>
      {summary.hasUsage && summary.contextLimit ? <>
        <div className="companion-context-meter" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, summary.usagePercent)}>
          <span style={{ width: `${Math.min(100, summary.usagePercent)}%` }} />
        </div>
        <p className="typography-meta">{summary.usagePercent.toFixed(1)}% used</p>
      </> : <p className="typography-meta text-muted-foreground">{summary.hasUsage ? 'Context limit unavailable' : 'Usage appears after an assistant turn reports tokens.'}</p>}
    </section>
    <dl className="companion-context-metrics">
      {metrics.map(([label, value]) => <div key={label}><dt className="typography-meta text-muted-foreground">{label}</dt><dd className="typography-ui-label">{value}</dd></div>)}
    </dl>
  </main>;
};

const FileRail = ({ view }: { view: CompanionView }) => (
  <aside className="companion-scroll companion-files" data-scroll="files">
    {view.files.length === 0 ? <Empty text="No changed files available. Tap Refresh to check the workspace." /> : (
      view.files.map((file, index) => (
        <Button key={index} variant="ghost" size="default" className="companion-file"
          aria-pressed={view.selectedFile === index} data-caction={view.tab === 'review' ? 'file' : 'preview'}
          data-index={index} disabled={!view.connected}>
          <span className="companion-file-copy">
            <span className="truncate text-foreground">{file.name}</span>
            <span className="truncate typography-micro text-muted-foreground">
              {file.parent || (file.staged ? 'Staged' : 'Working tree')}
            </span>
          </span>
          <span className="companion-count typography-micro">
            <span className="companion-added">{file.added ? `+${file.added}` : ''}</span>
            <span className="companion-removed">{file.removed ? `−${file.removed}` : ''}</span>
          </span>
        </Button>
      ))
    )}
  </aside>
);

const FilePreview = ({ view }: { view: CompanionView }) => {
  const preview = view.preview;
  if (view.loading) return <Empty text="Loading preview…" />;
  if (!preview) return <Empty text={view.tab === 'review' ? 'Select a file to review its diff here.' :
    'Select a changed file to preview its content here. Images open at their natural aspect ratio.'} />;
  return (
    <>
      <header className="companion-detail-title typography-ui-label">
        <span className="truncate">{preview.title}</span>
        <span className="typography-micro text-muted-foreground">
          {view.tab === 'review' ? (view.selectedFile !== null && view.files[view.selectedFile]?.staged ? 'Staged' : 'Working tree') : 'Read only'}
        </span>
      </header>
      <div className="companion-scroll companion-preview" data-scroll={`preview-${view.selectedFile}`}>
        {preview.kind === 'image' ? (
          <img src={preview.content} alt={preview.title} className="companion-image" />
        ) : preview.kind === 'diff' ? (
          <div className="companion-code companion-diff" aria-label="Unified diff">
            {companionDiffLines(preview.content).map((line, index) => (
              <div key={index} className={`companion-diff-row companion-diff-${line.kind}`}>
                <span className="companion-line-number" aria-hidden="true">{line.oldLine ?? ''}</span>
                <span className="companion-line-number" aria-hidden="true">{line.newLine ?? ''}</span>
                <code>{line.text || ' '}</code>
              </div>
            ))}
          </div>
        ) : preview.kind === 'text' ? (
          <pre className="companion-code">{preview.content}</pre>
        ) : <Empty text={preview.content} />}
      </div>
    </>
  );
};

const AttentionTray = ({ view }: { view: CompanionView }) => (
  <main className="companion-scroll companion-attention" data-scroll="attention">
    {view.questions.length === 0 ? <Empty text="No pending questions in loaded sessions." /> : (
      view.questions.map((question, index) => (
        <section key={index} className="companion-question">
          <p className="typography-meta text-muted-foreground">{question.session}</p>
          <h2 className="typography-ui-header text-foreground">{question.title}</h2>
          {question.message && <p className="typography-ui-label companion-question-message">{question.message}</p>}
          <div className="companion-choices">
            {question.options.length > 0 ? question.options.map((option, choice) => (
              <Button key={choice} variant="outline" size="default" data-caction="answer"
                data-index={index} data-choice={choice} disabled={!view.connected || view.loading}>
                {option}
              </Button>
            )) : (
              <Button variant="outline" size="default" data-caction="question" data-index={index} disabled={!view.connected}>
                Answer on top screen
              </Button>
            )}
          </div>
        </section>
      ))
    )}
  </main>
);

/** Static presentation only. The primary app validates and owns every action. */
export const CompanionSurface = ({ view }: { view: CompanionView }) => (
  <div className="oc-companion" data-view={view.tab}>
    <WorkspaceTabs view={view} />
    <div className="companion-context typography-meta text-muted-foreground">
      <span>{view.workspace || 'Choose a workspace'}</span>
      <span>{view.connected ? view.selectedSession : 'Host disconnected'}</span>
    </div>
    {view.error && <div role="alert" className="companion-error typography-ui-label">{view.error}</div>}
    {view.tab === 'sessions' && <SessionBoard view={view} />}
    {(view.tab === 'review' || view.tab === 'artifacts') && (
      <main className="companion-review"><FileRail view={view} /><section className="companion-detail"><FilePreview view={view} /></section></main>
    )}
    {view.tab === 'extensions' && (
      <main className="companion-extensions">
        <ExtensionWidgetsContent widgets={view.widgets ?? []} collapsedWidgets={view.collapsedWidgets ?? {}} companion />
      </main>
    )}
    {view.tab === 'context' && <ContextSummary view={view} />}
    {view.tab === 'attention' && <AttentionTray view={view} />}
  </div>
);
