import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime, historyMessages } from '../../src/agent/runtime';
import { createProvider } from '../../src/providers/factory';
import { nullLogger } from '../../src/shared/logger';
import { MockServer } from '../mock/mockServer';
import { RecordingEvents } from './helpers';

const server = new MockServer();
let baseUrl = '';
beforeAll(async () => {
  baseUrl = await server.start();
});
afterAll(() => server.stop());
afterEach(() => server.reset());

function setup() {
  const events = new RecordingEvents();
  const provider = createProvider({ id: 'mock', baseUrl, model: 'mock-model', timeoutSeconds: 5 }, { retryBaseDelayMs: 5 });
  return {
    events,
    runtime: new AgentRuntime({
      provider,
      events,
      host: { confirmContext: async () => true },
      logger: nullLogger,
      limits: { defaultContextWindow: 32000, confirmBeforeSend: false },
    }),
  };
}

const request = (prompt: string, history: Array<{ user: string; assistant: string }> = []) => ({
  prompt,
  attachments: [],
  mode: 'auto' as const,
  history,
});

describe('chat runtime', () => {
  it('streams a reply into the transcript and records the turn', async () => {
    server.enqueue({ type: 'text', text: 'Streaming works as expected.', chunkSize: 4, usage: { prompt_tokens: 30, completion_tokens: 6 } });
    const { events, runtime } = setup();
    const result = await runtime.run(request('hello'), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.turn).toEqual({ user: 'hello', assistant: 'Streaming works as expected.' });
    expect(events.kinds).toEqual(['user', 'assistant']);
    expect(events.of('assistant')[0]).toMatchObject({ text: 'Streaming works as expected.', streaming: false });
    expect(events.deltas).toBeGreaterThan(2);
    expect(events.usages.at(-1)).toEqual({ inputTokens: 30, outputTokens: 6, estimated: false });
  });

  it('estimates usage when the provider reports none', async () => {
    server.enqueue({ type: 'text', text: 'no usage here' });
    const { events, runtime } = setup();
    await runtime.run(request('hello'), new AbortController().signal);
    expect(events.usages.at(-1)?.estimated).toBe(true);
    expect(events.usages.at(-1)?.inputTokens).toBeGreaterThan(0);
  });

  it('sends a system prompt, earlier turns and the new prompt in order', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    const { runtime } = setup();
    await runtime.run(request('second question', [{ user: 'first question', assistant: 'first answer' }]), new AbortController().signal);
    const messages = server.chatRequests[0]!.body.messages;
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[0].content).toContain('ByteAgent');
    expect(messages[1].content).toBe('first question');
    expect(messages[3].content).toBe('second question');
  });

  it('shows a provider failure as an error item with retry, and records no turn', async () => {
    server.enqueue({ type: 'error', status: 401, body: { error: { message: 'bad key' } } });
    const { events, runtime } = setup();
    const result = await runtime.run(request('hello'), new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.turn).toBeUndefined();
    const error = events.of('error')[0];
    expect(error).toMatchObject({ code: 'auth', canRetry: true, openSettings: true });
    expect(events.of('assistant')[0]?.streaming).toBe(false);
  });

  it('stops when cancelled, keeps partial text and says so', async () => {
    server.enqueue({ type: 'text', text: 'word '.repeat(200), chunkSize: 5, delayMs: 10 });
    const { events, runtime } = setup();
    const controller = new AbortController();
    events.onDelta = () => {
      if (events.deltas === 4) controller.abort();
    };
    const result = await runtime.run(request('hello'), controller.signal);
    expect(result.status).toBe('cancelled');
    expect(result.assistantText.length).toBeGreaterThan(0);
    expect(result.assistantText.length).toBeLessThan(600);
    expect(events.of('notice')[0]?.text).toBe('Stopped.');
    expect(events.of('assistant')[0]?.streaming).toBe(false);
    expect(events.of('error')).toHaveLength(0);
  });

  it('warns about empty and cut-off replies', async () => {
    server.enqueue({ type: 'text', text: '' });
    const first = setup();
    const result = await first.runtime.run(request('hello'), new AbortController().signal);
    expect(result.turn).toBeUndefined();
    expect(first.events.of('notice')[0]?.text).toMatch(/empty/);

    server.enqueue({ type: 'text', text: 'partial', omitDone: true, omitFinish: true });
    const second = setup();
    await second.runtime.run(request('hello'), new AbortController().signal);
    expect(second.events.of('notice')[0]?.text).toMatch(/before the reply was complete/);
  });
});

describe('historyMessages', () => {
  it('keeps the newest turns that fit the budget', () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ user: `q${i} ${'x'.repeat(300)}`, assistant: `a${i}` }));
    const messages = historyMessages(turns, 400);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(20);
    expect(messages.at(-1)?.content).toBe('a9');
  });
  it('includes recorded action notes with the assistant message', () => {
    const messages = historyMessages([{ user: 'q', assistant: 'a', notes: 'Applied: src/a.ts' }], 1000);
    expect(messages[1]?.content).toContain('Applied: src/a.ts');
  });
  it('returns nothing when even one turn does not fit', () => {
    expect(historyMessages([{ user: 'x'.repeat(5000), assistant: 'a' }], 100)).toEqual([]);
  });
});
