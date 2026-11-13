import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from 'react';
import type {
  AppState,
  Attachment,
  ChatItem,
  HostMessage,
  ViewName,
} from '../../src/shared/protocol';
import { loadUiState, onHostMessage, post, saveUiState } from './vscode';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface UiState {
  app: AppState;
  view: ViewName;
  draft: string;
  attachments: Attachment[];
  /** Whether the active editor file is offered as context. */
  includeActiveFile: boolean;
  toasts: Toast[];
  focusTick: number;
  /** Latest reply to a request, keyed by request id. */
  replies: Record<string, HostMessage>;
}

const EMPTY_APP: AppState = {
  ready: false,
  hasWorkspace: false,
  workspaceName: '',
  profiles: [],
  activeProfileId: '',
  presets: [],
  settingsProblems: [],
  defaultMode: 'auto',
  sessions: [],
  sessionId: '',
  items: [],
  busy: false,
  usage: null,
  tasks: [],
  projectInitialized: false,
  editor: {},
};

export type Action =
  | { type: 'host'; message: HostMessage }
  | { type: 'setView'; view: ViewName }
  | { type: 'setDraft'; draft: string }
  | { type: 'addAttachment'; attachment: Attachment }
  | { type: 'removeAttachment'; index: number }
  | { type: 'clearComposer' }
  | { type: 'toggleActiveFile' }
  | { type: 'dismissToast'; id: number }
  | { type: 'clearReply'; requestId: string };

let toastId = 0;

function sameAttachment(a: Attachment, b: Attachment): boolean {
  return a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;
}

function patchItem(items: ChatItem[], id: string, patch: Record<string, unknown>): ChatItem[] {
  return items.map((item) => (item.id === id ? ({ ...item, ...patch } as ChatItem) : item));
}

function reduceHost(state: UiState, message: HostMessage): UiState {
  switch (message.type) {
    case 'state':
      return { ...state, app: message.state };
    case 'itemAdded': {
      if (message.sessionId !== state.app.sessionId) return state;
      if (state.app.items.some((i) => i.id === message.item.id)) return state;
      return { ...state, app: { ...state.app, items: [...state.app.items, message.item] } };
    }
    case 'itemUpdated': {
      if (message.sessionId !== state.app.sessionId) return state;
      return { ...state, app: { ...state.app, items: patchItem(state.app.items, message.id, message.patch) } };
    }
    case 'textDelta': {
      if (message.sessionId !== state.app.sessionId) return state;
      const items = state.app.items.map((item) =>
        item.id === message.id && item.kind === 'assistant'
          ? { ...item, text: item.text + message.delta }
          : item,
      );
      return { ...state, app: { ...state.app, items } };
    }
    case 'busy':
      if (message.sessionId !== state.app.sessionId) return state;
      return { ...state, app: { ...state.app, busy: message.busy } };
    case 'usage':
      if (message.sessionId !== state.app.sessionId) return state;
      return { ...state, app: { ...state.app, usage: message.usage } };
    case 'editorContext':
      return { ...state, app: { ...state.app, editor: message.editor } };
    case 'addAttachment': {
      if (state.attachments.some((a) => sameAttachment(a, message.attachment))) {
        return { ...state, view: 'chat', focusTick: state.focusTick + 1 };
      }
      return {
        ...state,
        view: 'chat',
        attachments: [...state.attachments, message.attachment],
        focusTick: state.focusTick + 1,
      };
    }
    case 'showView':
      return { ...state, view: message.view };
    case 'focusInput':
      return { ...state, view: 'chat', focusTick: state.focusTick + 1 };
    case 'toast': {
      toastId += 1;
      const toast: Toast = { id: toastId, level: message.level, message: message.message };
      return { ...state, toasts: [...state.toasts.slice(-2), toast] };
    }
    case 'profileSaved':
    case 'connectionResult':
    case 'models':
    case 'fileSuggestions':
      return { ...state, replies: { ...state.replies, [message.requestId]: message } };
    default:
      return state;
  }
}

function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'host':
      return reduceHost(state, action.message);
    case 'setView':
      return { ...state, view: action.view };
    case 'setDraft':
      return { ...state, draft: action.draft };
    case 'addAttachment':
      if (state.attachments.some((a) => sameAttachment(a, action.attachment))) return state;
      return { ...state, attachments: [...state.attachments, action.attachment] };
    case 'removeAttachment':
      return { ...state, attachments: state.attachments.filter((_, i) => i !== action.index) };
    case 'clearComposer':
      return { ...state, draft: '', attachments: [] };
    case 'toggleActiveFile':
      return { ...state, includeActiveFile: !state.includeActiveFile };
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'clearReply': {
      const { [action.requestId]: _removed, ...rest } = state.replies;
      return { ...state, replies: rest };
    }
    default:
      return state;
  }
}

interface Persisted {
  view: ViewName;
  draft: string;
  includeActiveFile: boolean;
}

function initialState(): UiState {
  const persisted = loadUiState<Persisted>({ view: 'chat', draft: '', includeActiveFile: true });
  return {
    app: EMPTY_APP,
    view: persisted.view,
    draft: persisted.draft,
    attachments: [],
    includeActiveFile: persisted.includeActiveFile,
    toasts: [],
    focusTick: 0,
    replies: {},
  };
}

const StoreContext = createContext<{ state: UiState; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    const off = onHostMessage((message) => dispatch({ type: 'host', message }));
    post({ type: 'ready' });
    return off;
  }, []);

  useEffect(() => {
    saveUiState({ view: state.view, draft: state.draft, includeActiveFile: state.includeActiveFile });
  }, [state.view, state.draft, state.includeActiveFile]);

  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore(): { state: UiState; dispatch: Dispatch<Action> } {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('StoreProvider is missing');
  return ctx;
}

/** Returns the host's reply to a request id once it arrives. */
export function useReply<T extends HostMessage['type']>(
  id: string | undefined,
  type: T,
): Extract<HostMessage, { type: T }> | undefined {
  const { state } = useStore();
  if (!id) return undefined;
  const reply = state.replies[id];
  return reply && reply.type === type ? (reply as Extract<HostMessage, { type: T }>) : undefined;
}
