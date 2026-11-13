import { memo, useState } from 'react';
import type { ChatItem, CommandRisk } from '../../../src/shared/protocol';
import { Icon, Spinner } from '../icons';
import { Markdown } from '../markdown';
import { useStore } from '../store';
import { post } from '../vscode';

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

const MODE_LABEL = { quick: 'Quick', standard: 'Standard', project: 'Project' } as const;
const MODE_ICON = { quick: 'bolt', standard: 'layers', project: 'list' } as const;

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function attachmentLabel(a: { path: string; startLine?: number; endLine?: number }): string {
  const name = a.path.split('/').pop() ?? a.path;
  if (a.startLine && a.endLine && a.endLine !== a.startLine) return `${name}:${a.startLine}-${a.endLine}`;
  if (a.startLine) return `${name}:${a.startLine}`;
  return name;
}

export { attachmentLabel, formatTokens, MODE_ICON, MODE_LABEL };

function UserItem({ item }: { item: Item<'user'> }) {
  return (
    <div className="msg msg--user">
      <div className="msg__bubble">{item.text}</div>
      {item.attachments.length > 0 && (
        <div className="msg__chips">
          {item.attachments.map((a, i) => (
            <button key={i} className="chip chip--button" title={a.path} onClick={() => post({ type: 'openFile', path: a.path, line: a.startLine })}>
              <Icon name="file" size={12} />
              <span className="chip__text">{attachmentLabel(a)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantItem({ item }: { item: Item<'assistant'> }) {
  if (!item.text) {
    return item.streaming ? (
      <div className="msg thinking">
        <Spinner /> Thinking…
      </div>
    ) : null;
  }
  return (
    <div className="msg msg--assistant">
      <Markdown text={item.text} />
    </div>
  );
}

function ClassificationItem({ item }: { item: Item<'classification'> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="row row--button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name={MODE_ICON[item.mode]} size={14} />
        <span className="row__title">
          {item.escalatedFrom ? `Switched to ${MODE_LABEL[item.mode]} mode` : `${MODE_LABEL[item.mode]} mode`}
          {!item.auto && !item.escalatedFrom ? ' (chosen by you)' : ''}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      {open && (
        <div className="details">
          {item.reasons.map((reason, i) => (
            <div key={i} className="details__item">
              {reason}
            </div>
          ))}
          <div className="details__item hint">Review and approval rules are the same in every mode.</div>
        </div>
      )}
    </div>
  );
}

function ContextItem({ item }: { item: Item<'context'> }) {
  const pending = item.confirm?.status === 'pending';
  const [open, setOpen] = useState(pending);
  const count = item.files.length;
  const title =
    count === 0 ? 'No project files sent' : `${count} file${count === 1 ? '' : 's'} sent as context · ${formatTokens(item.totalTokens)} tokens`;

  const list = (
    <div className="details">
      {item.files.map((file, i) => (
        <div key={i} className="details__item">
          <button className="details__path" title={file.path} onClick={() => post({ type: 'openFile', path: file.path, line: file.startLine })}>
            {file.path}
            {file.startLine ? `:${file.startLine}-${file.endLine ?? file.startLine}` : ''}
          </button>
          <span className="details__reason">
            {file.reason}
            {file.truncated ? ' · shortened' : ''}
          </span>
        </div>
      ))}
      {item.omitted.length > 0 && (
        <>
          <div className="details__label">Left out</div>
          {item.omitted.slice(0, 12).map((o, i) => (
            <div key={i} className="details__item">
              <span className="details__path" style={{ cursor: 'default' }}>
                {o.path}
              </span>
              <span className="details__reason">{o.reason}</span>
            </div>
          ))}
          {item.omitted.length > 12 && <div className="details__item hint">and {item.omitted.length - 12} more</div>}
        </>
      )}
    </div>
  );

  if (pending && item.confirm) {
    const requestId = item.confirm.requestId;
    return (
      <div className="card card--attention">
        <div className="card__head">
          <Icon name="shield" />
          <span className="card__title">Send this context to the provider?</span>
          <span className="card__meta">{formatTokens(item.totalTokens)} tokens</span>
        </div>
        <div className="card__body">{count === 0 ? <p className="card__text">Only your message will be sent.</p> : list}</div>
        <div className="card__foot">
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={() => post({ type: 'contextDecision', requestId, send: false })}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => post({ type: 'contextDecision', requestId, send: true })}>
            Send
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button className="row row--button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="book" size={14} />
        <span className="row__title">{item.confirm?.status === 'cancelled' ? 'Not sent' : title}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      {open && (count > 0 || item.omitted.length > 0) && list}
    </div>
  );
}

const TOOL_ICON: Record<string, string> = {
  read_file: 'file',
  search_files: 'search',
  list_directory: 'folder',
  git_status: 'git',
  git_diff: 'git',
  propose_changes: 'diff',
  run_command: 'terminal',
  update_plan: 'list',
};

function ToolItem({ item }: { item: Item<'tool'> }) {
  return (
    <div className={`row${item.status === 'error' ? ' row--error' : ''}`}>
      {item.status === 'running' ? <Spinner size={13} /> : <Icon name={item.status === 'error' ? 'warning' : (TOOL_ICON[item.tool] ?? 'circle')} size={14} />}
      {item.path ? (
        <button className="row__link" title={item.path} onClick={() => post({ type: 'openFile', path: item.path as string })}>
          {item.title}
        </button>
      ) : (
        <span className="row__title" title={item.title}>
          {item.title}
        </span>
      )}
      {item.detail && <span className="row__detail">· {item.detail}</span>}
    </div>
  );
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  applied: { label: 'Applied', cls: 'badge--ok' },
  rejected: { label: 'Rejected', cls: '' },
  stale: { label: 'File changed', cls: 'badge--warn' },
  failed: { label: 'Failed', cls: 'badge--fail' },
  accepted: { label: 'Applying', cls: 'badge--info' },
};

function ChangesItem({ item }: { item: Item<'changes'> }) {
  const pending = item.status === 'pending';
  // Deletions start unselected: the user has to opt in to each one.
  const [rejected, setRejected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(item.files.filter((f) => f.kind === 'delete').map((f) => [f.changeId, true])),
  );
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [sent, setSent] = useState(false);

  const added = item.files.reduce((n, f) => n + f.added, 0);
  const removed = item.files.reduce((n, f) => n + f.removed, 0);
  const acceptCount = item.files.filter((f) => !rejected[f.changeId]).length;
  const appliedCount = item.files.filter((f) => f.status === 'applied').length;

  const decide = (mode: 'selected' | 'none', note?: string): void => {
    const decisions: Record<string, 'accept' | 'reject'> = {};
    for (const file of item.files) decisions[file.changeId] = mode === 'none' || rejected[file.changeId] ? 'reject' : 'accept';
    setSent(true);
    post({ type: 'reviewDecision', changeSetId: item.changeSetId, decisions, feedback: note?.trim() || undefined });
  };

  const title = pending
    ? `Review ${item.files.length} change${item.files.length === 1 ? '' : 's'}`
    : appliedCount === item.files.length
      ? `Applied ${appliedCount} change${appliedCount === 1 ? '' : 's'}`
      : appliedCount === 0
        ? 'No changes applied'
        : `Applied ${appliedCount} of ${item.files.length} changes`;

  return (
    <div className={`card${pending && !sent ? ' card--attention' : ''}`}>
      <div className="card__head">
        <Icon name="diff" />
        <span className="card__title">{title}</span>
        <span className="card__meta">
          <span className="stat-add">+{added}</span>
          <span className="stat-del">−{removed}</span>
        </span>
      </div>
      {item.summary && (
        <div className="card__body">
          <p className="card__text">{item.summary}</p>
        </div>
      )}
      <div className="card__body card__body--flush">
        {item.files.map((file) => {
          const off = pending ? Boolean(rejected[file.changeId]) : file.status !== 'applied';
          const badge = STATUS_BADGE[file.status];
          return (
            <div key={file.changeId}>
              <div className="filerow">
                <Icon
                  name={file.kind === 'create' ? 'fileAdd' : file.kind === 'delete' ? 'fileRemove' : 'file'}
                  className={`filerow__icon--${file.kind}`}
                />
                <button
                  className={`filerow__path${off ? ' filerow__path--off' : ''}`}
                  title={`${file.path}: open diff`}
                  onClick={() => post({ type: 'openDiff', changeSetId: item.changeSetId, changeId: file.changeId })}
                >
                  {file.path}
                </button>
                <span className="filerow__stats">
                  {file.kind === 'delete' ? (
                    <span className="badge badge--fail">Delete</span>
                  ) : (
                    <>
                      {file.kind === 'create' && <span className="badge badge--ok">New</span>}
                      <span className="stat-add">+{file.added}</span>
                      <span className="stat-del">−{file.removed}</span>
                    </>
                  )}
                </span>
                {pending && !sent ? (
                  <span className="filerow__actions">
                    <button
                      className={`toggle toggle--accept${!rejected[file.changeId] ? ' toggle--on' : ''}`}
                      title="Include this file"
                      aria-label={`Include ${file.path}`}
                      aria-pressed={!rejected[file.changeId]}
                      onClick={() => setRejected((r) => ({ ...r, [file.changeId]: false }))}
                    >
                      <Icon name="check" size={13} />
                    </button>
                    <button
                      className={`toggle toggle--reject${rejected[file.changeId] ? ' toggle--on' : ''}`}
                      title="Leave this file out"
                      aria-label={`Leave out ${file.path}`}
                      aria-pressed={Boolean(rejected[file.changeId])}
                      onClick={() => setRejected((r) => ({ ...r, [file.changeId]: true }))}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                ) : pending ? (
                  <Spinner size={13} />
                ) : (
                  badge && <span className={`badge ${badge.cls}`}>{badge.label}</span>
                )}
              </div>
              {file.error && <div className="filerow__error">{file.error}</div>}
            </div>
          );
        })}
      </div>
      {pending && !sent && revising && (
        <form
          className="revise"
          style={{ paddingTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (feedback.trim()) decide('none', feedback);
          }}
        >
          <input className="input" autoFocus placeholder="What should be different?" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <button className="btn btn--primary" type="submit" disabled={!feedback.trim()}>
            Send
          </button>
        </form>
      )}
      {pending && !sent && (
        <div className="card__foot">
          <button className="btn btn--ghost" onClick={() => setRevising((v) => !v)}>
            <Icon name="edit" size={14} /> Ask for changes
          </button>
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={() => decide('none')}>
            Reject
          </button>
          <button className="btn btn--primary" disabled={acceptCount === 0} onClick={() => decide('selected')}>
            <Icon name="check" size={14} />
            {acceptCount === item.files.length ? (item.files.length === 1 ? 'Apply' : 'Apply all') : `Apply ${acceptCount}`}
          </button>
        </div>
      )}
      {!pending && item.feedback && (
        <div className="card__foot">
          <span className="hint">You asked for changes: {item.feedback}</span>
        </div>
      )}
    </div>
  );
}

const RISK_LABEL: Record<CommandRisk, string> = { safe: 'Low risk', moderate: 'Changes local state', destructive: 'Destructive' };

function CommandItem({ item }: { item: Item<'command'> }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const pending = item.status === 'pending';
  const decide = (decision: 'once' | 'always' | 'deny'): void => {
    setSent(true);
    post({ type: 'commandDecision', requestId: item.requestId, decision });
  };

  let statusNode = null;
  if (item.status === 'running' || (pending && sent)) statusNode = <Spinner size={13} />;
  else if (item.status === 'done') {
    statusNode = <span className={`badge ${item.exitCode === 0 ? 'badge--ok' : 'badge--fail'}`}>{item.exitCode === 0 ? 'Passed' : `Exit ${item.exitCode ?? '?'}`}</span>;
  } else if (item.status === 'denied') statusNode = <span className="badge">Not run</span>;
  else if (item.status === 'timeout') statusNode = <span className="badge badge--fail">Timed out</span>;
  else if (item.status === 'cancelled') statusNode = <span className="badge">Stopped</span>;
  else if (item.status === 'error') statusNode = <span className="badge badge--fail">Failed to start</span>;

  const attention = pending && !sent;
  return (
    <div className={`card${attention ? (item.risk === 'destructive' ? ' card--danger' : ' card--attention') : ''}`}>
      <div className="card__head">
        <Icon name="terminal" />
        <span className="card__title">{attention ? 'Run this command?' : item.verification ? 'Check' : 'Command'}</span>
        <span className="card__meta">
          {attention && <span className={`badge badge--${item.risk}`}>{RISK_LABEL[item.risk]}</span>}
          {item.remembered && <span className="badge">Always allowed</span>}
          {item.durationMs !== undefined && <span>{formatDuration(item.durationMs)}</span>}
          {statusNode}
        </span>
      </div>
      <div className="card__body">
        <pre className="command">{item.command}</pre>
        {attention && item.purpose && <p className="card__text" style={{ marginTop: 6 }}>{item.purpose}</p>}
        {attention && item.risk !== 'safe' && item.riskReasons.length > 0 && (
          <ul className="reasons">
            {item.riskReasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        )}
        {item.output !== undefined && item.output !== '' && (
          <>
            <button className="disclosure" style={{ marginTop: 4 }} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /> Output
            </button>
            {open && <pre className="output">{item.output}</pre>}
          </>
        )}
      </div>
      {attention && (
        <div className="card__foot">
          <button className="btn btn--secondary" onClick={() => decide('deny')}>
            Deny
          </button>
          <span className="spacer" />
          {item.canRemember && (
            <button className="btn btn--secondary" title="Run now and do not ask again for this exact command in this workspace" onClick={() => decide('always')}>
              Always allow
            </button>
          )}
          <button className={`btn ${item.risk === 'destructive' ? 'btn--danger' : 'btn--primary'}`} onClick={() => decide('once')}>
            <Icon name="play" size={13} /> {item.risk === 'destructive' ? 'Run anyway' : 'Run'}
          </button>
        </div>
      )}
    </div>
  );
}

function PlanItem({ item }: { item: Item<'plan'> }) {
  const done = item.steps.filter((s) => s.status === 'done').length;
  const [showCriteria, setShowCriteria] = useState(false);
  return (
    <div className="card">
      <div className="card__head">
        <Icon name="list" />
        <span className="card__title">{item.goal || 'Plan'}</span>
        <span className="card__meta">
          {done}/{item.steps.length}
        </span>
      </div>
      <ol className="plan">
        {item.steps.map((step) => (
          <li key={step.id} className={`plan__step plan__step--${step.status}`}>
            {step.status === 'in_progress' ? (
              <Spinner size={13} />
            ) : (
              <Icon name={step.status === 'done' ? 'check' : step.status === 'blocked' ? 'warning' : 'circle'} size={14} />
            )}
            <span>{step.title}</span>
          </li>
        ))}
      </ol>
      {item.criteria.length > 0 && (
        <div className="card__body">
          <button className="disclosure" onClick={() => setShowCriteria((v) => !v)} aria-expanded={showCriteria}>
            <Icon name={showCriteria ? 'chevronDown' : 'chevronRight'} size={12} /> Acceptance criteria ({item.criteria.length})
          </button>
          {showCriteria && (
            <ul className="reasons">
              {item.criteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function OutcomeItem({ item }: { item: Item<'outcome'> }) {
  const o = item.outcome;
  const checks = o.commands.filter((c) => c.verification);
  return (
    <div className="card">
      <div className="card__head">
        <Icon name="shield" />
        <span className="card__title">What happened</span>
        <span className="card__meta">recorded by ByteAgent</span>
      </div>
      <div className="outcome">
        {o.applied.length > 0 && (
          <div className="outcome__line outcome__line--ok">
            <Icon name="check" size={14} />
            <span>
              Changed {o.applied.length} file{o.applied.length === 1 ? '' : 's'}: <span className="outcome__files">{o.applied.join(', ')}</span>
            </span>
          </div>
        )}
        {o.rejected.length > 0 && (
          <div className="outcome__line outcome__line--muted">
            <Icon name="close" size={14} />
            <span>
              Not applied (rejected): <span className="outcome__files">{o.rejected.join(', ')}</span>
            </span>
          </div>
        )}
        {o.failed.map((f, i) => (
          <div key={i} className="outcome__line outcome__line--fail">
            <Icon name="error" size={14} />
            <span>
              <span className="outcome__files">{f.path}</span> was not changed: {f.error}
            </span>
          </div>
        ))}
        {o.applied.length === 0 && o.rejected.length === 0 && o.failed.length === 0 && (
          <div className="outcome__line outcome__line--muted">
            <Icon name="info" size={14} />
            <span>No files were changed.</span>
          </div>
        )}
        {o.commands.map((c, i) => (
          <div key={i} className={`outcome__line ${c.passed ? 'outcome__line--ok' : 'outcome__line--fail'}`}>
            <Icon name={c.passed ? 'check' : 'error'} size={14} />
            <span>
              <span className="outcome__files">{c.command}</span> {c.passed ? 'exited with 0' : c.exitCode === null ? 'did not finish' : `exited with ${c.exitCode}`}
            </span>
          </div>
        ))}
        {o.diagnostics && (
          <div className={`outcome__line ${o.diagnostics.errors > 0 ? 'outcome__line--fail' : o.diagnostics.warnings > 0 ? 'outcome__line--warn' : 'outcome__line--ok'}`}>
            <Icon name={o.diagnostics.errors > 0 ? 'error' : o.diagnostics.warnings > 0 ? 'warning' : 'check'} size={14} />
            <span>
              Editor diagnostics in changed files: {o.diagnostics.errors} error{o.diagnostics.errors === 1 ? '' : 's'}, {o.diagnostics.warnings} warning
              {o.diagnostics.warnings === 1 ? '' : 's'}
            </span>
          </div>
        )}
        <div className={`outcome__line ${o.verification === 'passed' ? 'outcome__line--ok' : o.verification === 'failed' ? 'outcome__line--fail' : 'outcome__line--warn'}`}>
          <Icon name={o.verification === 'passed' ? 'check' : o.verification === 'failed' ? 'error' : 'warning'} size={14} />
          <strong>
            {o.verification === 'passed'
              ? `Verified: ${checks.length} check${checks.length === 1 ? '' : 's'} passed`
              : o.verification === 'failed'
                ? 'Verification failed'
                : 'Not verified: no check was run'}
          </strong>
        </div>
        {o.notes.map((note, i) => (
          <div key={i} className="outcome__line outcome__line--muted">
            <Icon name="info" size={14} />
            <span>{note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NoticeItem({ item }: { item: Item<'notice'> }) {
  return (
    <div className="row" style={item.level === 'warn' ? { color: 'var(--ba-yellow)' } : undefined}>
      <Icon name={item.level === 'warn' ? 'warning' : 'info'} size={14} />
      <span style={{ whiteSpace: 'normal' }}>{item.text}</span>
    </div>
  );
}

function ErrorItem({ item, isLast }: { item: Item<'error'>; isLast: boolean }) {
  const { dispatch } = useStore();
  return (
    <div className="banner banner--error" role="alert">
      <Icon name="error" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{item.message}</div>
        {(item.canRetry || item.openSettings) && isLast && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {item.canRetry && (
              <button className="btn btn--secondary btn--small" onClick={() => post({ type: 'retry' })}>
                <Icon name="refresh" size={12} /> Try again
              </button>
            )}
            {item.openSettings && (
              <button className="btn btn--secondary btn--small" onClick={() => dispatch({ type: 'setView', view: 'settings' })}>
                <Icon name="gear" size={12} /> Provider settings
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const ChatItemView = memo(function ChatItemView({ item, isLast }: { item: ChatItem; isLast: boolean }) {
  switch (item.kind) {
    case 'user':
      return <UserItem item={item} />;
    case 'assistant':
      return <AssistantItem item={item} />;
    case 'classification':
      return <ClassificationItem item={item} />;
    case 'context':
      return <ContextItem item={item} />;
    case 'tool':
      return <ToolItem item={item} />;
    case 'changes':
      return <ChangesItem item={item} />;
    case 'command':
      return <CommandItem item={item} />;
    case 'plan':
      return <PlanItem item={item} />;
    case 'outcome':
      return <OutcomeItem item={item} />;
    case 'notice':
      return <NoticeItem item={item} />;
    case 'error':
      return <ErrorItem item={item} isLast={isLast} />;
    default:
      return null;
  }
});
