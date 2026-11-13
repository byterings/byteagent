import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatItem } from '../../../src/shared/protocol';
import { Composer } from '../components/Composer';
import { ChatItemView } from '../components/Items';
import { Icon, Logo, Spinner } from '../icons';
import { useStore } from '../store';
import { post } from '../vscode';

/** Whether something on screen already shows that work is in progress. */
function showsActivity(item: ChatItem | undefined): boolean {
  if (!item) return false;
  if (item.kind === 'assistant') return item.streaming;
  if (item.kind === 'tool') return item.status === 'running';
  if (item.kind === 'changes') return item.status === 'pending';
  if (item.kind === 'command') return item.status === 'pending' || item.status === 'running';
  if (item.kind === 'context') return item.confirm?.status === 'pending';
  return false;
}

export function ChatView() {
  const { state, dispatch } = useStore();
  const { app } = state;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const last = app.items[app.items.length - 1];

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [app.items, app.busy]);

  // A newly opened conversation always starts at its end.
  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [app.sessionId]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = near;
    setAtBottom(near);
  };

  const jump = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const suggest = (text: string): void => {
    dispatch({ type: 'setDraft', draft: text });
    dispatch({ type: 'host', message: { type: 'focusInput' } });
  };

  const file = app.editor.activeFile?.split('/').pop();
  const suggestions: Array<{ icon: string; text: string }> = file
    ? [
        { icon: 'book', text: `Explain what ${file} does` },
        { icon: 'search', text: `Look for bugs in ${file}` },
        { icon: 'check', text: `Add tests for ${file}` },
      ]
    : [
        { icon: 'book', text: 'Give me a tour of this project' },
        { icon: 'search', text: 'Where is the main entry point?' },
        { icon: 'check', text: 'How do I run the tests?' },
      ];

  return (
    <div className="chat">
      <div className="chat__scroll-wrap">
        <div className="chat__scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="chat__inner">
            {app.items.length === 0 ? (
              <div className="empty">
                <Logo size={44} />
                <h2>What should we work on?</h2>
                <p className="hint">
                  {app.hasWorkspace
                    ? `ByteAgent reads only what a request needs in ${app.workspaceName || 'this workspace'} and asks before changing anything.`
                    : 'Open a folder so ByteAgent can read and change your project.'}
                </p>
                {app.hasWorkspace && (
                  <div className="suggestions">
                    {suggestions.map((s) => (
                      <button key={s.text} className="suggestion" onClick={() => suggest(s.text)}>
                        <Icon name={s.icon} />
                        <span>{s.text}</span>
                      </button>
                    ))}
                  </div>
                )}
                {app.tasks.length > 0 && (
                  <div className="suggestions">
                    {app.tasks.slice(0, 2).map((task) => (
                      <button key={task.id} className="suggestion" onClick={() => post({ type: 'resumeTask', taskId: task.id })} title="Continue this unfinished task">
                        <Icon name="play" />
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          Resume: {task.title}
                        </span>
                        <span className="hint" style={{ marginLeft: 'auto', flex: 'none' }}>
                          {task.stepsDone}/{task.stepsTotal}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {app.hasWorkspace && !app.projectInitialized && (
                  <button className="link" style={{ marginTop: 10 }} onClick={() => post({ type: 'initProject' })}>
                    <Icon name="sparkle" size={12} /> Set up project knowledge
                  </button>
                )}
              </div>
            ) : (
              app.items.map((item, index) => <ChatItemView key={item.id} item={item} isLast={index === app.items.length - 1} />)
            )}
            {app.busy && !showsActivity(last) && (
              <div className="thinking">
                <Spinner /> Working…
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <button className="btn btn--icon chat__jump" onClick={jump} title="Jump to latest" aria-label="Jump to latest">
            <Icon name="chevronDown" />
          </button>
        )}
      </div>
      <Composer />
    </div>
  );
}
