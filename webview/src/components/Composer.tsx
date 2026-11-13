import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Attachment, ModeSetting, ProfileDraft } from '../../../src/shared/protocol';
import { Icon, Spinner } from '../icons';
import { useReply, useStore } from '../store';
import { post, requestId } from '../vscode';
import { attachmentLabel, formatTokens } from './Items';

const MODES: Array<{ id: ModeSetting; label: string; icon: string; desc: string }> = [
  { id: 'auto', label: 'Auto', icon: 'sparkle', desc: 'ByteAgent picks the depth for each request' },
  { id: 'quick', label: 'Quick', icon: 'bolt', desc: 'Small, local tasks with minimal context' },
  { id: 'standard', label: 'Standard', icon: 'layers', desc: 'Related files, a short plan, focused checks' },
  { id: 'project', label: 'Project', icon: 'list', desc: 'Tracked plan, step by step, verified' },
];

interface MentionState {
  start: number;
  query: string;
  requestId: string;
  index: number;
}

export function Composer() {
  const { state, dispatch } = useStore();
  const { app, draft, attachments, includeActiveFile, focusTick } = state;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<'mode' | 'model' | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);

  const active = app.profiles.find((p) => p.id === app.activeProfileId);
  const mode = MODES.find((m) => m.id === app.defaultMode) ?? MODES[0]!;
  const suggestions = useReply(mention?.requestId, 'fileSuggestions')?.files ?? [];

  const editorAttachment = useMemo<Attachment | undefined>(() => {
    const { selection, activeFile } = app.editor;
    if (selection) return { path: selection.path, startLine: selection.startLine, endLine: selection.endLine, source: 'selection' };
    if (activeFile) return { path: activeFile, source: 'active' };
    return undefined;
  }, [app.editor]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusTick]);

  useEffect(() => {
    if (!menu && !mention) return;
    const close = (event: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setMenu(null);
        setMention(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu, mention]);

  const canSend = draft.trim().length > 0 && !app.busy;

  const send = (): void => {
    if (!canSend) return;
    const all: Attachment[] = [...attachments];
    if (includeActiveFile && editorAttachment && !all.some((a) => a.path === editorAttachment.path && a.startLine === editorAttachment.startLine)) {
      all.push(editorAttachment);
    }
    post({ type: 'sendPrompt', text: draft, mode: app.defaultMode, attachments: all });
    dispatch({ type: 'clearComposer' });
    setMention(null);
  };

  const updateMention = (text: string, caret: number): void => {
    const before = text.slice(0, caret);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[2] ?? '';
    const id = requestId();
    post({ type: 'searchFiles', requestId: id, query });
    setMention({ start: caret - query.length - 1, query, requestId: id, index: 0 });
  };

  const pickMention = (path: string): void => {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const next = draft.slice(0, mention.start) + draft.slice(caret);
    dispatch({ type: 'setDraft', draft: next });
    dispatch({ type: 'addAttachment', attachment: { path, source: 'mention' } });
    setMention(null);
    window.requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(mention.start, mention.start);
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention && suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, index: (mention.index + step + suggestions.length) % suggestions.length });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const chosen = suggestions[Math.min(mention.index, suggestions.length - 1)];
        if (chosen) pickMention(chosen);
        return;
      }
    }
    if (event.key === 'Escape') {
      if (mention || menu) {
        event.preventDefault();
        setMention(null);
        setMenu(null);
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const usage = app.usage;

  return (
    <div className="composer">
      <div className="composer__box" ref={boxRef}>
        {mention && (
          <div className="menu menu--up" role="listbox" aria-label="Files">
            {suggestions.length === 0 ? (
              <div className="menu__label">{mention.query ? 'No matching files' : 'Type to search files'}</div>
            ) : (
              suggestions.map((file, i) => (
                <button
                  key={file}
                  role="option"
                  aria-selected={i === mention.index}
                  className={`menu__item${i === mention.index ? ' menu__item--active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(file);
                  }}
                >
                  <Icon name="file" size={14} />
                  <span className="menu__path" title={file}>
                    {file}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {menu === 'mode' && (
          <div className="menu menu--up" role="menu">
            <div className="menu__label">Depth</div>
            {MODES.map((m) => (
              <button
                key={m.id}
                role="menuitemradio"
                aria-checked={m.id === mode.id}
                className="menu__item"
                onClick={() => {
                  post({ type: 'setMode', mode: m.id });
                  setMenu(null);
                }}
              >
                <Icon name={m.icon} size={14} />
                <span className="menu__text">
                  <span className="menu__title">{m.label}</span>
                  <span className="menu__desc">{m.desc}</span>
                </span>
                {m.id === mode.id && <Icon name="check" size={14} className="menu__check" />}
              </button>
            ))}
            <div className="menu__sep" />
            <div className="menu__label" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
              Every mode asks before changing files or running commands.
            </div>
          </div>
        )}

        {menu === 'model' && <ModelMenu onClose={() => setMenu(null)} />}

        {(attachments.length > 0 || editorAttachment) && (
          <div className="composer__chips">
            {editorAttachment && (
              <button
                className={`chip chip--button${includeActiveFile ? '' : ' chip--off'}`}
                style={{ fontFamily: 'inherit' }}
                title={includeActiveFile ? `${editorAttachment.path} will be sent as context. Click to leave it out.` : 'Not included. Click to include the current file.'}
                aria-pressed={includeActiveFile}
                onClick={() => dispatch({ type: 'toggleActiveFile' })}
              >
                <Icon name={includeActiveFile ? 'eye' : 'eyeOff'} size={12} />
                <span className="chip__text">{attachmentLabel(editorAttachment)}</span>
                <span className="chip__meta">{editorAttachment.source === 'selection' ? 'selection' : 'current file'}</span>
              </button>
            )}
            {attachments.map((a, i) => (
              <span key={`${a.path}:${a.startLine ?? 0}`} className="chip" title={a.path}>
                <Icon name="file" size={12} />
                <span className="chip__text">{attachmentLabel(a)}</span>
                <button className="chip__remove" aria-label={`Remove ${a.path}`} onClick={() => dispatch({ type: 'removeAttachment', index: i })}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={draft}
          placeholder={app.busy ? 'ByteAgent is working…' : 'Ask ByteAgent, or type @ to add a file'}
          aria-label="Message"
          onChange={(e) => {
            dispatch({ type: 'setDraft', draft: e.target.value });
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => updateMention(draft, e.currentTarget.selectionStart)}
        />

        <div className="composer__bar">
          <button
            className="select-btn"
            aria-haspopup="menu"
            aria-expanded={menu === 'mode'}
            title="How deep ByteAgent goes"
            onClick={() => {
              setMention(null);
              setMenu(menu === 'mode' ? null : 'mode');
            }}
          >
            <Icon name={mode.icon} size={13} />
            <span className="select-btn__label">{mode.label}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          <button
            className="select-btn"
            aria-haspopup="menu"
            aria-expanded={menu === 'model'}
            title={active ? `${active.name} · ${active.model}` : 'Choose a provider'}
            onClick={() => {
              setMention(null);
              setMenu(menu === 'model' ? null : 'model');
            }}
          >
            <span className="select-btn__label">{active ? active.model : 'No provider'}</span>
            <Icon name="chevronDown" size={11} />
          </button>
          <span className="composer__spacer" />
          {usage && (
            <span
              className="composer__usage"
              title={`Last request: ${usage.inputTokens.toLocaleString()} tokens in, ${usage.outputTokens.toLocaleString()} out${usage.estimated ? ' (estimated)' : ''}`}
            >
              {usage.estimated ? '~' : ''}
              {formatTokens(usage.inputTokens + usage.outputTokens)}
            </span>
          )}
          {app.busy ? (
            <button className="send send--stop" onClick={() => post({ type: 'stop' })} title="Stop" aria-label="Stop">
              <Icon name="stop" />
            </button>
          ) : (
            <button className="send" onClick={send} disabled={!canSend} title="Send (Enter)" aria-label="Send">
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelMenu({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { profiles, activeProfileId } = state.app;
  const active = profiles.find((p) => p.id === activeProfileId);
  const [modelsId, setModelsId] = useState<string>();
  const [filter, setFilter] = useState('');
  const models = useReply(modelsId, 'models');

  const loadModels = (): void => {
    if (!active) return;
    const id = requestId();
    setModelsId(id);
    const draft: ProfileDraft = { id: active.id, name: active.name, baseUrl: active.baseUrl, model: active.model };
    post({ type: 'listModels', requestId: id, draft });
  };

  const shown = (models?.models ?? []).filter((m) => m.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
  const typed = filter.trim();

  return (
    <div className="menu menu--up" role="menu" style={{ left: 'auto', right: 0, minWidth: 240 }}>
      <div className="menu__label">Provider</div>
      {profiles.map((p) => (
        <button
          key={p.id}
          role="menuitemradio"
          aria-checked={p.id === activeProfileId}
          className="menu__item"
          onClick={() => {
            post({ type: 'setActiveProfile', id: p.id });
            onClose();
          }}
        >
          <Icon name="plug" size={14} />
          <span className="menu__text">
            <span className="menu__title">{p.name}</span>
            <span className="menu__desc">{p.model}</span>
          </span>
          {p.id === activeProfileId && <Icon name="check" size={14} className="menu__check" />}
        </button>
      ))}
      <div className="menu__sep" />
      {!modelsId ? (
        <button className="menu__item" onClick={loadModels} disabled={!active}>
          <Icon name="refresh" size={14} />
          <span className="menu__title">Change model…</span>
        </button>
      ) : (
        <>
          <div className="menu__label">Model for {active?.name}</div>
          <input
            className="input menu__input"
            autoFocus
            placeholder="Filter or type a model name"
            value={filter}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed) {
                post({ type: 'setModel', model: shown.length === 1 ? (shown[0] as string) : typed });
                onClose();
              }
            }}
          />
          {!models && (
            <div className="menu__label">
              <Spinner size={11} /> Loading…
            </div>
          )}
          {models?.error && <div className="menu__label" style={{ textTransform: 'none', letterSpacing: 0 }}>{models.error}</div>}
          {shown.map((m) => (
            <button
              key={m}
              className="menu__item"
              onClick={() => {
                post({ type: 'setModel', model: m });
                onClose();
              }}
            >
              <span className="menu__title" style={{ fontFamily: 'var(--ba-mono)', fontSize: '0.92em' }}>
                {m}
              </span>
              {m === active?.model && <Icon name="check" size={14} className="menu__check" />}
            </button>
          ))}
          {models && !models.error && shown.length === 0 && typed && (
            <button
              className="menu__item"
              onClick={() => {
                post({ type: 'setModel', model: typed });
                onClose();
              }}
            >
              <span className="menu__title">Use “{typed}”</span>
            </button>
          )}
        </>
      )}
      <div className="menu__sep" />
      <button
        className="menu__item"
        onClick={() => {
          dispatch({ type: 'setView', view: 'settings' });
          onClose();
        }}
      >
        <Icon name="gear" size={14} />
        <span className="menu__title">Provider settings…</span>
      </button>
    </div>
  );
}
