import { Icon } from '../icons';
import { useStore } from '../store';
import { post } from '../vscode';

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function HistoryView() {
  const { state, dispatch } = useStore();
  const { sessions, sessionId, tasks } = state.app;
  const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');

  return (
    <div className="page">
      <header className="page__header">
        <button className="btn btn--ghost btn--icon" onClick={() => dispatch({ type: 'setView', view: 'chat' })} title="Back to chat" aria-label="Back to chat">
          <Icon name="arrowLeft" />
        </button>
        <h2>History</h2>
        <span style={{ flex: 1 }} />
        <button className="btn btn--secondary btn--small" onClick={() => post({ type: 'newChat' })}>
          <Icon name="plus" size={13} /> New chat
        </button>
      </header>

      {openTasks.length > 0 && (
        <>
          <div className="section-title">Unfinished tasks</div>
          <ul className="history">
            {openTasks.map((task) => (
              <li key={task.id} className="history__item">
                <button className="history__open" onClick={() => post({ type: 'resumeTask', taskId: task.id })} title="Resume this task">
                  <span className="history__title">{task.title}</span>
                  <span className="history__meta">
                    {task.stepsDone}/{task.stepsTotal} steps · {task.status.replace(/_/g, ' ')} · {relativeTime(task.updatedAt)}
                  </span>
                  {task.stepsTotal > 0 && (
                    <span className="progress">
                      <span style={{ width: `${Math.round((task.stepsDone / task.stepsTotal) * 100)}%` }} />
                    </span>
                  )}
                </button>
                <span className="pill pill--accent" style={{ marginRight: 8 }}>
                  Resume
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {sessions.length > 0 && <div className="section-title">Conversations</div>}
      {sessions.length === 0 ? (
        <p className="hint">No conversations yet. Your chats in this workspace will appear here.</p>
      ) : (
        <ul className="history">
          {sessions.map((session) => (
            <li key={session.id} className={`history__item${session.id === sessionId ? ' history__item--current' : ''}`}>
              <button className="history__open" onClick={() => post({ type: 'openSession', id: session.id })}>
                <span className="history__title">{session.title}</span>
                <span className="history__meta">
                  {relativeTime(session.updatedAt)} · {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
                </span>
              </button>
              <button className="btn btn--ghost btn--icon" title="Delete conversation" aria-label={`Delete ${session.title}`} onClick={() => post({ type: 'deleteSession', id: session.id })}>
                <Icon name="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
