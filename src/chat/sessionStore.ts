import type { Turn } from '../agent/host';
import { newId } from '../shared/hash';
import type { ChatItem, SessionSummary, UsageView } from '../shared/protocol';

/** Minimal key-value storage; VS Code's workspaceState satisfies it. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: ChatItem[];
  turns: Turn[];
  usage: UsageView | null;
  taskId?: string;
}

const INDEX_KEY = 'byteagent.sessions';
const SESSION_PREFIX = 'byteagent.session.';
const MAX_SESSIONS = 50;
const MAX_TITLE = 60;

/** Chat sessions for the current workspace. */
export class SessionStore {
  constructor(private readonly storage: KeyValueStore) {}

  list(): SessionSummary[] {
    const index = this.storage.get<SessionSummary[]>(INDEX_KEY);
    return Array.isArray(index) ? [...index].sort((a, b) => b.updatedAt - a.updatedAt) : [];
  }

  create(): Session {
    const now = Date.now();
    return { id: newId('s'), title: 'New chat', createdAt: now, updatedAt: now, items: [], turns: [], usage: null };
  }

  get(id: string): Session | undefined {
    const stored = this.storage.get<Session>(SESSION_PREFIX + id);
    if (!stored || !Array.isArray(stored.items)) return undefined;
    return { ...stored, items: stored.items.map(settleItem), turns: stored.turns ?? [], usage: stored.usage ?? null };
  }

  async save(session: Session): Promise<void> {
    // Empty sessions are not worth keeping in history.
    if (session.items.length === 0) return;
    session.updatedAt = Date.now();
    await this.storage.update(SESSION_PREFIX + session.id, session);
    const summary: SessionSummary = {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: session.items.filter((i) => i.kind === 'user').length,
    };
    const index = [summary, ...this.list().filter((s) => s.id !== session.id)];
    for (const old of index.slice(MAX_SESSIONS)) await this.storage.update(SESSION_PREFIX + old.id, undefined);
    await this.storage.update(INDEX_KEY, index.slice(0, MAX_SESSIONS));
  }

  async delete(id: string): Promise<void> {
    await this.storage.update(SESSION_PREFIX + id, undefined);
    await this.storage.update(
      INDEX_KEY,
      this.list().filter((s) => s.id !== id),
    );
  }
}

export function titleFromPrompt(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!line) return 'New chat';
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

/**
 * A stored transcript may end mid-run (window closed, crash). Anything
 * that was waiting or running is marked as no longer active so the UI
 * never shows a live prompt for a run that does not exist.
 */
export function settleItem(item: ChatItem): ChatItem {
  switch (item.kind) {
    case 'assistant':
      return item.streaming ? { ...item, streaming: false } : item;
    case 'tool':
      return item.status === 'running' ? { ...item, status: 'error', detail: 'interrupted' } : item;
    case 'changes':
      return item.status === 'pending'
        ? {
            ...item,
            status: 'resolved',
            files: item.files.map((f) => (f.status === 'pending' ? { ...f, status: 'rejected', error: 'Not reviewed before the session ended.' } : f)),
          }
        : item;
    case 'command':
      return item.status === 'pending' || item.status === 'running' ? { ...item, status: 'cancelled' } : item;
    case 'context':
      return item.confirm?.status === 'pending' ? { ...item, confirm: { ...item.confirm, status: 'cancelled' } } : item;
    default:
      return item;
  }
}
