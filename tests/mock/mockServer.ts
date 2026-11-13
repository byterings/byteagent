/**
 * A scriptable OpenAI-compatible server for tests. No network access and
 * no real model: each request is answered from a queue or a responder.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockToolCall {
  name: string;
  arguments: unknown;
  id?: string;
}

export type MockReply =
  | { type: 'text'; text: string; chunkSize?: number; usage?: { prompt_tokens: number; completion_tokens: number }; delayMs?: number; omitDone?: boolean; omitFinish?: boolean }
  | { type: 'tools'; calls: MockToolCall[]; text?: string; splitArguments?: number }
  | { type: 'error'; status: number; body?: unknown; headers?: Record<string, string> }
  | { type: 'json'; text?: string; calls?: MockToolCall[] }
  | { type: 'raw'; status?: number; headers?: Record<string, string>; chunks: string[]; delayMs?: number }
  | { type: 'hang' }
  | { type: 'stall'; text: string }
  | { type: 'drop'; text?: string };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export type Responder = (request: RecordedRequest, index: number) => MockReply | undefined;

export class MockServer {
  readonly requests: RecordedRequest[] = [];
  models: string[] = ['mock-model', 'mock-model-small'];
  /** When set, requests without this bearer token get 401. */
  requiredKey: string | undefined;
  private server: Server | undefined;
  private queue: MockReply[] = [];
  private responder: Responder | undefined;
  private readonly open = new Set<ServerResponse>();
  private chatCount = 0;

  get chatRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/chat/completions'));
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this.baseUrl;
  }

  get baseUrl(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error('mock server is not started');
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    for (const res of this.open) res.destroy();
    this.open.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  reset(): void {
    this.requests.length = 0;
    this.queue = [];
    this.responder = undefined;
    this.chatCount = 0;
    this.requiredKey = undefined;
  }

  /** Replies used in order, one per chat request. */
  enqueue(...replies: MockReply[]): void {
    this.queue.push(...replies);
  }

  /** A function consulted when the queue is empty. */
  respondWith(responder: Responder): void {
    this.responder = responder;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    const recorded: RecordedRequest = { method: req.method ?? 'GET', path, headers: req.headers, body };
    this.requests.push(recorded);

    if (this.requiredKey && req.headers.authorization !== `Bearer ${this.requiredKey}`) {
      sendJson(res, 401, { error: { message: `Incorrect API key provided: ${String(req.headers.authorization ?? '').replace('Bearer ', '')}`, type: 'invalid_request_error' } });
      return;
    }

    if (req.method === 'GET' && path.endsWith('/models')) {
      sendJson(res, 200, { object: 'list', data: this.models.map((id) => ({ id, object: 'model' })) });
      return;
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      const index = this.chatCount++;
      const reply = this.queue.shift() ?? this.responder?.(recorded, index) ?? { type: 'text', text: 'ok' };
      await this.send(res, reply);
      return;
    }
    sendJson(res, 404, { error: { message: `Unknown path ${path}` } });
  }

  private async send(res: ServerResponse, reply: MockReply): Promise<void> {
    this.open.add(res);
    res.on('close', () => this.open.delete(res));
    const sse = (): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    };
    const data = (payload: unknown): void => {
      res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
    };
    const chunk = (delta: unknown, finish: string | null = null, extra: object = {}): object => ({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    });

    switch (reply.type) {
      case 'text': {
        sse();
        data(chunk({ role: 'assistant', content: '' }));
        const size = reply.chunkSize ?? 12;
        for (let i = 0; i < reply.text.length; i += size) {
          if (reply.delayMs) await delay(reply.delayMs);
          if (res.destroyed) return;
          data(chunk({ content: reply.text.slice(i, i + size) }));
        }
        if (!reply.omitFinish) data(chunk({}, 'stop', reply.usage ? { usage: reply.usage } : {}));
        if (!reply.omitDone) data('[DONE]');
        res.end();
        return;
      }
      case 'tools': {
        sse();
        if (reply.text) data(chunk({ role: 'assistant', content: reply.text }));
        reply.calls.forEach((call, index) => {
          const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
          const id = call.id ?? `call_mock_${index}_${Math.random().toString(36).slice(2, 8)}`;
          const pieces = reply.splitArguments && reply.splitArguments > 1 ? splitInto(args, reply.splitArguments) : [args];
          data(chunk({ tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: '' } }] }));
          for (const piece of pieces) data(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
        });
        data(chunk({}, 'tool_calls'));
        data('[DONE]');
        res.end();
        return;
      }
      case 'json': {
        sendJson(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: reply.calls?.length ? 'tool_calls' : 'stop',
              message: {
                role: 'assistant',
                content: reply.text ?? null,
                tool_calls: reply.calls?.map((call, index) => ({
                  id: call.id ?? `call_json_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        });
        return;
      }
      case 'error': {
        res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? { error: { message: 'mock error' } }));
        return;
      }
      case 'raw': {
        res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'text/event-stream' });
        for (const part of reply.chunks) {
          if (reply.delayMs) await delay(reply.delayMs);
          if (res.destroyed) return;
          res.write(part);
        }
        res.end();
        return;
      }
      case 'hang':
        return; // never answers
      case 'stall': {
        sse();
        data(chunk({ role: 'assistant', content: reply.text }));
        return; // keeps the stream open without sending more
      }
      case 'drop': {
        sse();
        if (reply.text) data(chunk({ role: 'assistant', content: reply.text }));
        await delay(20);
        res.destroy();
        return;
      }
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function splitInto(text: string, parts: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
