import { describe, expect, it } from 'vitest';
import { SessionStore, settleItem, titleFromPrompt, type KeyValueStore } from '../../src/chat/sessionStore';
import type { ChatItem } from '../../src/shared/protocol';

function memory(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => (data.has(key) ? (JSON.parse(JSON.stringify(data.get(key))) as T) : undefined),
    update: async (key, value) => {
      if (value === undefined) data.delete(key);
      else data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

const userItem = (text: string): ChatItem => ({ kind: 'user', id: `u-${text}`, text, attachments: [], mode: 'auto' });

describe('SessionStore', () => {
  it('does not persist empty sessions', async () => {
    const store = new SessionStore(memory());
    await store.save(store.create());
    expect(store.list()).toEqual([]);
  });

  it('saves, lists newest first, loads and deletes', async () => {
    const kv = memory();
    const store = new SessionStore(kv);
    const a = store.create();
    a.title = 'first';
    a.items.push(userItem('a'));
    await store.save(a);
    await new Promise((r) => setTimeout(r, 3));
    const b = store.create();
    b.title = 'second';
    b.items.push(userItem('b'), userItem('c'));
    b.turns.push({ user: 'b', assistant: 'reply' });
    await store.save(b);

    expect(store.list().map((s) => s.title)).toEqual(['second', 'first']);
    expect(store.list()[0]?.messageCount).toBe(2);
    expect(store.get(b.id)?.turns).toEqual([{ user: 'b', assistant: 'reply' }]);

    await store.delete(a.id);
    expect(store.list().map((s) => s.id)).toEqual([b.id]);
    expect(store.get(a.id)).toBeUndefined();
  });

  it('keeps at most 50 sessions and removes the data of older ones', async () => {
    const kv = memory();
    const store = new SessionStore(kv);
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) {
      const s = store.create();
      s.items.push(userItem(String(i)));
      ids.push(s.id);
      await store.save(s);
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(store.list()).toHaveLength(50);
    expect(store.get(ids[0]!)).toBeUndefined();
    expect(store.get(ids[52]!)).toBeDefined();
    expect([...kv.data.keys()].filter((k) => k.startsWith('byteagent.session.'))).toHaveLength(50);
  });

  it('returns undefined for unknown or corrupt sessions', () => {
    const kv = memory();
    kv.data.set('byteagent.session.x', { nope: true });
    const store = new SessionStore(kv);
    expect(store.get('x')).toBeUndefined();
    expect(store.get('missing')).toBeUndefined();
  });
});

describe('settleItem', () => {
  it('turns live states into finished ones', () => {
    expect(settleItem({ kind: 'assistant', id: 'a', text: 'x', streaming: true })).toMatchObject({ streaming: false });
    expect(settleItem({ kind: 'tool', id: 't', tool: 'read_file', title: 'Read', status: 'running' })).toMatchObject({ status: 'error' });
    const changes = settleItem({
      kind: 'changes',
      id: 'c',
      changeSetId: 'cs',
      summary: '',
      status: 'pending',
      files: [
        { changeId: '1', path: 'a', kind: 'modify', added: 1, removed: 0, status: 'pending' },
        { changeId: '2', path: 'b', kind: 'modify', added: 1, removed: 0, status: 'applied' },
      ],
    });
    expect(changes).toMatchObject({ status: 'resolved' });
    if (changes.kind === 'changes') expect(changes.files.map((f) => f.status)).toEqual(['rejected', 'applied']);
    expect(
      settleItem({ kind: 'command', id: 'k', requestId: 'r', command: 'x', purpose: '', risk: 'safe', riskReasons: [], canRemember: true, remembered: false, status: 'pending', verification: false }),
    ).toMatchObject({ status: 'cancelled' });
  });
});

describe('titleFromPrompt', () => {
  it('uses the first line, shortened', () => {
    expect(titleFromPrompt('  Fix the bug\nmore detail')).toBe('Fix the bug');
    expect(titleFromPrompt('x'.repeat(100)).length).toBe(60);
    expect(titleFromPrompt('   ')).toBe('New chat');
  });
});
