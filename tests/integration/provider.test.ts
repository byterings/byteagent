import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from '../../src/providers/openaiCompatible';
import type { StreamEvent } from '../../src/providers/types';
import { ProviderError } from '../../src/shared/errors';
import { Redactor } from '../../src/shared/redact';
import { MockServer } from '../mock/mockServer';

const server = new MockServer();
let baseUrl = '';

beforeAll(async () => {
  baseUrl = await server.start();
});
afterAll(() => server.stop());
afterEach(() => server.reset());

function provider(overrides: Partial<OpenAICompatibleOptions> = {}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'mock',
    baseUrl,
    model: 'mock-model',
    timeoutMs: 2000,
    idleTimeoutMs: 2000,
    retryBaseDelayMs: 5,
    ...overrides,
  });
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected the call to fail');
}

const user = (content: string) => ({ messages: [{ role: 'user' as const, content }] });
const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

describe('OpenAI-compatible provider: streaming', () => {
  it('streams text deltas in order and ends with done', async () => {
    server.enqueue({ type: 'text', text: 'Hello from the mock server!', chunkSize: 5, usage: { prompt_tokens: 9, completion_tokens: 6 } });
    const events = await collect(provider().stream(user('hi')));
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta);
    expect(text.length).toBeGreaterThan(1);
    expect(text.join('')).toBe('Hello from the mock server!');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 9, outputTokens: 6 } });
  });

  it('sends the model, messages, key and generation settings', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    await provider({ apiKey: 'key-abc-123456', temperature: 0.3, maxOutputTokens: 256 }).chat({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
        { role: 'tool', toolCallId: 'c1', content: 'file text' },
      ],
      tools,
    });
    const req = server.chatRequests[0]!;
    expect(req.headers.authorization).toBe('Bearer key-abc-123456');
    expect(req.body.model).toBe('mock-model');
    expect(req.body.stream).toBe(true);
    expect(req.body.temperature).toBe(0.3);
    expect(req.body.max_tokens).toBe(256);
    expect(req.body.messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    });
    expect(req.body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file text' });
    expect(req.body.tools[0]).toEqual({ type: 'function', function: tools[0] });
  });

  it('omits the Authorization header when there is no key', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    await provider().chat(user('hi'));
    expect(server.chatRequests[0]!.headers.authorization).toBeUndefined();
  });

  it('assembles tool calls whose arguments arrive in fragments', async () => {
    server.enqueue({
      type: 'tools',
      text: 'Let me look.',
      splitArguments: 7,
      calls: [
        { name: 'read_file', arguments: { path: 'src/a.ts', note: 'héllo "quoted"' }, id: 'call_a' },
        { name: 'search_files', arguments: { query: 'x' }, id: 'call_b' },
      ],
    });
    const res = await provider().chat({ ...user('hi'), tools });
    expect(res.content).toBe('Let me look.');
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0]).toMatchObject({ id: 'call_a', name: 'read_file' });
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toEqual({ path: 'src/a.ts', note: 'héllo "quoted"' });
    expect(JSON.parse(res.toolCalls[1]!.arguments)).toEqual({ query: 'x' });
  });

  it('accepts a non-streaming JSON answer', async () => {
    server.enqueue({ type: 'json', text: 'whole answer', calls: [{ name: 'read_file', arguments: { path: 'a' } }] });
    const res = await provider().chat({ ...user('hi'), tools });
    expect(res.content).toBe('whole answer');
    expect(res.toolCalls[0]?.name).toBe('read_file');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it('reports an incomplete stream when content arrived but no end marker did', async () => {
    server.enqueue({ type: 'text', text: 'partial answer', omitDone: true, omitFinish: true });
    const res = await provider().chat(user('hi'));
    expect(res.content).toBe('partial answer');
    expect(res.finishReason).toBe('incomplete');
  });

  it('skips malformed chunks but keeps valid ones', async () => {
    server.enqueue({
      type: 'raw',
      chunks: [
        'data: {not json}\n\n',
        ': comment\n\n',
        'data: {"choices":[{"delta":{"content":"good"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    });
    const res = await provider().chat(user('hi'));
    expect(res.content).toBe('good');
    expect(res.finishReason).toBe('stop');
  });

  it('ignores reasoning fields and unknown delta keys', async () => {
    server.enqueue({
      type: 'raw',
      chunks: [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking…"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ],
    });
    expect((await provider().chat(user('hi'))).content).toBe('answer');
  });
});

describe('OpenAI-compatible provider: failures', () => {
  it('fails with bad_stream when the stream is empty or entirely malformed', async () => {
    server.enqueue({ type: 'raw', chunks: [] });
    expect((await failure(provider().chat(user('hi')))).code).toBe('bad_stream');
    server.enqueue({ type: 'raw', chunks: ['data: <html>\n\n', 'data: nope\n\n'] });
    expect((await failure(provider().chat(user('hi')))).code).toBe('bad_stream');
  });

  it('surfaces an error object sent inside the stream', async () => {
    server.enqueue({ type: 'raw', chunks: ['data: {"error":{"message":"model overloaded","type":"overloaded_error"}}\n\n'] });
    const err = await failure(provider({ maxRetries: 0 }).chat(user('hi')));
    expect(err.code).toBe('rate_limit');
    expect(err.message).toContain('model overloaded');
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [400, 'bad_request'],
    [422, 'bad_request'],
    [429, 'rate_limit'],
    [500, 'server'],
    [503, 'server'],
  ])('maps HTTP %i to %s', async (status, code) => {
    server.enqueue({ type: 'error', status, body: { error: { message: `problem ${status}` } } });
    const err = await failure(provider({ maxRetries: 0 }).chat(user('hi')));
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toContain(`problem ${status}`);
  });

  it('never leaks the API key through an error message', async () => {
    const redactor = new Redactor();
    const key = 'secret-key-for-leak-test-0001';
    redactor.addSecret(key);
    server.requiredKey = 'a-different-key';
    const err = await failure(provider({ apiKey: key, redact: (t) => redactor.redact(t) }).chat(user('hi')));
    expect(err.code).toBe('auth');
    expect(err.message).not.toContain(key);
    expect(err.message).toContain('[REDACTED]');
    const test = await provider({ apiKey: key, redact: (t) => redactor.redact(t) }).testConnection();
    expect(test.ok).toBe(false);
    expect(JSON.stringify(test)).not.toContain(key);
  });

  it('drops HTML error pages instead of showing markup', async () => {
    server.enqueue({ type: 'error', status: 502, body: '<html><body>Bad gateway</body></html>' });
    const err = await failure(provider({ maxRetries: 0 }).chat(user('hi')));
    expect(err.code).toBe('server');
    expect(err.message).not.toContain('<html>');
  });

  it('retries rate limits and server errors a bounded number of times, then succeeds', async () => {
    server.enqueue({ type: 'error', status: 429 }, { type: 'error', status: 503 }, { type: 'text', text: 'finally' });
    const res = await provider({ maxRetries: 2 }).chat(user('hi'));
    expect(res.content).toBe('finally');
    expect(server.chatRequests).toHaveLength(3);
  });

  it('gives up after the retry limit', async () => {
    server.enqueue({ type: 'error', status: 500 }, { type: 'error', status: 500 }, { type: 'error', status: 500 }, { type: 'text', text: 'never' });
    const err = await failure(provider({ maxRetries: 2 }).chat(user('hi')));
    expect(err.code).toBe('server');
    expect(server.chatRequests).toHaveLength(3);
  });

  it('does not retry authentication or bad-request errors', async () => {
    server.enqueue({ type: 'error', status: 401 }, { type: 'text', text: 'never' });
    await failure(provider().chat(user('hi')));
    expect(server.chatRequests).toHaveLength(1);
  });

  it('does not retry after output has started', async () => {
    server.enqueue({ type: 'drop', text: 'half an ans' }, { type: 'text', text: 'second attempt' });
    const events: StreamEvent[] = [];
    let error: unknown;
    try {
      for await (const e of provider().stream(user('hi'))) events.push(e);
    } catch (err) {
      error = err;
    }
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('half an ans');
    // Either the drop surfaces as an error or as an incomplete stream; never as a silent retry.
    if (!error) expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'incomplete' });
    expect(server.chatRequests).toHaveLength(1);
  });

  it('times out when the provider never starts responding', async () => {
    server.enqueue({ type: 'hang' });
    const started = Date.now();
    const err = await failure(provider({ timeoutMs: 150, maxRetries: 0 }).chat(user('hi')));
    expect(err.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('times out when a running stream goes silent', async () => {
    server.enqueue({ type: 'stall', text: 'starting…' });
    const err = await failure(provider({ timeoutMs: 1000, idleTimeoutMs: 150, maxRetries: 0 }).chat(user('hi')));
    expect(err.code).toBe('timeout');
  });

  it('reports a refused connection as a network error', async () => {
    const err = await failure(provider({ baseUrl: 'http://127.0.0.1:9/v1', maxRetries: 0 }).chat(user('hi')));
    expect(err.code).toBe('network');
  });
});

describe('OpenAI-compatible provider: cancellation', () => {
  it('stops a running stream when the signal aborts', async () => {
    server.enqueue({ type: 'text', text: 'x'.repeat(400), chunkSize: 4, delayMs: 15 });
    const controller = new AbortController();
    const seen: string[] = [];
    const err = await failure(
      (async () => {
        for await (const e of provider().stream(user('hi'), controller.signal)) {
          if (e.type === 'text') {
            seen.push(e.delta);
            if (seen.length === 3) controller.abort();
          }
        }
      })(),
    );
    expect(err.code).toBe('cancelled');
    expect(seen.length).toBeLessThan(20);
  });

  it('fails immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await failure(provider().chat(user('hi'), controller.signal));
    expect(err.code).toBe('cancelled');
    expect(server.chatRequests).toHaveLength(0);
  });

  it('cancels while waiting to retry', async () => {
    server.enqueue({ type: 'error', status: 503 }, { type: 'text', text: 'never' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const err = await failure(provider({ retryBaseDelayMs: 5000 }).chat(user('hi'), controller.signal));
    expect(err.code).toBe('cancelled');
    expect(server.chatRequests).toHaveLength(1);
  });
});

describe('OpenAI-compatible provider: capability handling', () => {
  it('detects endpoints that reject tools and reports tools_unsupported', async () => {
    server.enqueue({ type: 'error', status: 400, body: { error: { message: 'This model does not support tools' } } });
    const p = provider();
    expect(p.getCapabilities().toolCalling).toBe('unknown');
    const err = await failure(p.chat({ ...user('hi'), tools }));
    expect(err.code).toBe('tools_unsupported');
    expect(p.getCapabilities().toolCalling).toBe('none');
  });

  it('marks tool calling as native after a successful request with tools', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    const p = provider();
    await p.chat({ ...user('hi'), tools });
    expect(p.getCapabilities().toolCalling).toBe('native');
  });

  it('respects the configured tool calling mode', () => {
    expect(provider({ toolCalling: 'text' }).getCapabilities().toolCalling).toBe('none');
    expect(provider({ toolCalling: 'native' }).getCapabilities().toolCalling).toBe('native');
  });

  it('switches to max_completion_tokens when the endpoint asks for it', async () => {
    server.enqueue(
      { type: 'error', status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } } },
      { type: 'text', text: 'ok' },
    );
    const res = await provider({ maxOutputTokens: 100 }).chat(user('hi'));
    expect(res.content).toBe('ok');
    expect(server.chatRequests[1]!.body.max_completion_tokens).toBe(100);
    expect(server.chatRequests[1]!.body.max_tokens).toBeUndefined();
  });

  it('drops temperature when the endpoint does not support it', async () => {
    server.enqueue(
      { type: 'error', status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } } },
      { type: 'text', text: 'ok' },
    );
    const res = await provider({ temperature: 0.2 }).chat(user('hi'));
    expect(res.content).toBe('ok');
    expect(server.chatRequests[1]!.body.temperature).toBeUndefined();
  });
});

describe('OpenAI-compatible provider: connection test and models', () => {
  it('reports a working connection with latency', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    const result = await provider().testConnection();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed connection with a helpful message', async () => {
    server.enqueue({ type: 'error', status: 404, body: { error: { message: 'model not found' } } });
    const result = await provider().testConnection();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('not_found');
    expect(result.message).toMatch(/base URL and model/i);
  });

  it('lists models sorted and unique', async () => {
    server.models = ['zeta', 'alpha', 'alpha', 'mid'];
    expect((await provider().listModels()).map((m) => m.id)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('fails model listing with a mapped error', async () => {
    server.requiredKey = 'needed';
    expect((await failure(provider().listModels())).code).toBe('auth');
  });
});
