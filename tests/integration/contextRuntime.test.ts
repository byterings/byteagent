import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentHost } from '../../src/agent/host';
import { AgentRuntime } from '../../src/agent/runtime';
import { createProvider } from '../../src/providers/factory';
import { nullLogger } from '../../src/shared/logger';
import type { Attachment } from '../../src/shared/protocol';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';
import { MockServer } from '../mock/mockServer';
import { FakeHost, RecordingEvents } from './helpers';

const server = new MockServer();
let baseUrl = '';
let ws: TempWorkspace | undefined;
beforeAll(async () => {
  baseUrl = await server.start();
});
afterAll(() => server.stop());
afterEach(() => {
  server.reset();
  ws?.dispose();
  ws = undefined;
});

function setup(options: { confirm?: boolean; host?: Partial<AgentHost>; contextWindow?: number; noWorkspace?: boolean } = {}) {
  ws = tempWorkspace(sampleProject());
  const events = new RecordingEvents();
  const provider = createProvider({ id: 'mock', baseUrl, model: 'mock-model', timeoutSeconds: 5, contextWindow: options.contextWindow }, { retryBaseDelayMs: 5 });
  const runtime = new AgentRuntime({
    provider,
    events,
    host: Object.assign(new FakeHost(ws.root), options.host ?? {}),
    logger: nullLogger,
    workspace: options.noWorkspace ? undefined : { index: ws.index() },
    limits: { defaultContextWindow: 32000, confirmBeforeSend: options.confirm ?? false },
  });
  return { events, runtime };
}

const request = (prompt: string, attachments: Attachment[] = []) => ({ prompt, attachments, mode: 'auto' as const, history: [] });
const lastUserMessage = (): string => server.chatRequests.at(-1)!.body.messages.at(-1).content as string;

describe('context in a run (Scenario A: read-only question)', () => {
  it('sends the relevant file, shows what was sent, and creates no diff', async () => {
    server.enqueue({ type: 'text', text: 'orderTotal sums the lines, applies tax, then the coupon.' });
    const { events, runtime } = setup();
    const result = await runtime.run(request('What does orderTotal do?'), new AbortController().signal);

    expect(result.status).toBe('completed');
    const sent = lastUserMessage();
    expect(sent).toContain('<file path="src/services/pricing.ts">');
    expect(sent).toContain('export function orderTotal');
    expect(sent).toContain('User request:\nWhat does orderTotal do?');

    const context = events.of('context')[0];
    expect(context?.files[0]?.path).toBe('src/services/pricing.ts');
    expect(context?.totalTokens).toBeGreaterThan(0);
    expect(events.of('changes')).toEqual([]);
    expect(events.of('plan')).toEqual([]);
    expect(events.kinds).toEqual(['user', 'classification', 'context', 'assistant']);
    expect(events.of('classification')[0]).toMatchObject({ mode: 'quick', auto: true });
    // History keeps the question, not the file contents.
    expect(result.turn?.user).toBe('What does orderTotal do?');
  });

  it('never sends the whole repository, unrelated files, or blocked files', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    const { runtime } = setup();
    await runtime.run(request('What does orderTotal do?'), new AbortController().signal);
    const body = JSON.stringify(server.chatRequests[0]!.body);
    for (const secret of ['hunter2', 'topsecretvalue123', 'sk_live_abcdefghijklmnop', 'MIIabc']) expect(body, secret).not.toContain(secret);
    expect(body).not.toContain('sendReceipt');
    expect(body).not.toContain('capitalize');
    expect(body).not.toContain('node_modules/express');
  });

  it('reports a blocked attachment instead of sending it', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    const { events, runtime } = setup();
    await runtime.run(request('what is in this file?', [{ path: '.env', source: 'mention' }]), new AbortController().signal);
    expect(events.of('context')[0]?.omitted).toContainEqual({ path: '.env', reason: 'sensitive file' });
    expect(JSON.stringify(server.chatRequests[0]!.body)).not.toContain('hunter2');
  });

  it('sends only the message when nothing in the project is relevant', async () => {
    server.enqueue({ type: 'text', text: 'Hello!' });
    const { events, runtime } = setup();
    await runtime.run(request('hello, can you help me?'), new AbortController().signal);
    expect(events.of('context')[0]?.files).toEqual([]);
    expect(lastUserMessage()).toBe('hello, can you help me?');
  });

  it('adds no context item when no folder is open', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    const { events, runtime } = setup({ noWorkspace: true });
    await runtime.run(request('What does orderTotal do?'), new AbortController().signal);
    expect(events.kinds).toEqual(['user', 'classification', 'assistant']);
  });

  it('keeps the request inside a small context window', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    const { events, runtime } = setup({ contextWindow: 3000 });
    await runtime.run(request('Explain orderTotal, roundCents, createApp and ordersRouter in detail'), new AbortController().signal);
    const context = events.of('context')[0];
    expect(context?.totalTokens).toBeLessThanOrEqual(context?.budget ?? 0);
    expect(context?.budget).toBeLessThan(1500);
  });
});

describe('confirm before send', () => {
  it('waits for approval and sends nothing when declined', async () => {
    const { events, runtime } = setup({ confirm: true, host: { confirmContext: async () => false } });
    const result = await runtime.run(request('What does orderTotal do?'), new AbortController().signal);
    expect(result.status).toBe('cancelled');
    expect(server.chatRequests).toHaveLength(0);
    expect(events.of('context')[0]?.confirm?.status).toBe('cancelled');
    expect(events.of('assistant')).toEqual([]);
    expect(events.of('notice')[0]?.text).toBe('Nothing was sent.');
  });

  it('sends after approval', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    let asked = 0;
    const { events, runtime } = setup({
      confirm: true,
      host: {
        confirmContext: async () => {
          asked += 1;
          expect(server.chatRequests).toHaveLength(0);
          return true;
        },
      },
    });
    await runtime.run(request('What does orderTotal do?'), new AbortController().signal);
    expect(asked).toBe(1);
    expect(server.chatRequests).toHaveLength(1);
    expect(events.of('context')[0]?.confirm?.status).toBe('sent');
  });
});
