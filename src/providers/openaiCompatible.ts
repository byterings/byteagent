import { describeError, ProviderError, type ProviderErrorCode } from '../shared/errors';
import { SseParser } from './sse';
import {
  collectStream,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ConnectionTestResult,
  type FinishReason,
  type ModelInfo,
  type Provider,
  type ProviderCapabilities,
  type StreamEvent,
  type TokenUsage,
  type ToolCall,
} from './types';

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  /** Time allowed until the provider starts responding. */
  timeoutMs: number;
  /** Time allowed between two chunks of a running stream. */
  idleTimeoutMs?: number;
  toolCalling?: 'auto' | 'native' | 'text';
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  /** Applied to every error message before it leaves this module. */
  redact?: (text: string) => string;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

const MAX_ERROR_BODY = 2000;
const MAX_RETRY_AFTER_SECONDS = 20;

/**
 * Adapter for the widely implemented `POST /chat/completions` streaming
 * protocol. All vendor JSON shapes stay inside this file.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly model: string;

  private readonly options: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly redact: (text: string) => string;
  private toolSupport: 'native' | 'none' | 'unknown';
  /** Parameter adjustments learned from this endpoint's error messages. */
  private useMaxCompletionTokens = false;
  private omitTemperature = false;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
    this.id = options.id;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.redact = options.redact ?? ((text) => text);
    this.toolSupport =
      options.toolCalling === 'native' ? 'native' : options.toolCalling === 'text' ? 'none' : 'unknown';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: this.toolSupport,
      structuredOutput: false,
      embeddings: false,
      contextWindow: this.options.contextWindow,
      maxOutputTokens: this.options.maxOutputTokens,
    };
  }

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const maxRetries = this.options.maxRetries ?? 2;
    const baseDelay = this.options.retryBaseDelayMs ?? 600;
    const hadTools = Boolean(request.tools && request.tools.length > 0);
    let attempt = 0;

    for (;;) {
      let delivered = false;
      try {
        for await (const event of this.streamOnce(request, signal)) {
          delivered = true;
          yield event;
        }
        if (hadTools && this.toolSupport === 'unknown') this.toolSupport = 'native';
        return;
      } catch (err) {
        const error = this.normalizeError(err, signal);
        if (error.code === 'tools_unsupported') this.toolSupport = 'none';
        // Once any event has reached the caller a retry would duplicate output.
        if (delivered) throw error;
        if (error.code === 'bad_request' && this.learnFromBadRequest(error.message)) continue;
        if (!error.retryable || attempt >= maxRetries) throw error;
        attempt += 1;
        const wait = error.retryAfterSeconds
          ? Math.min(error.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000
          : baseDelay * 2 ** (attempt - 1);
        await sleep(wait, signal);
      }
    }
  }

  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return collectStream(this.stream(request, signal));
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const response = await this.chat(
        { messages: [{ role: 'user', content: 'Reply with the single word: ok' }] },
        signal,
      );
      const latencyMs = Date.now() - started;
      const replied = response.content.trim().length > 0 || response.toolCalls.length > 0;
      return {
        ok: true,
        latencyMs,
        message: replied
          ? `Connected. ${this.model} replied.`
          : `Connected, but ${this.model} returned an empty reply.`,
      };
    } catch (err) {
      return {
        ok: false,
        message: this.redact(describeError(err)),
        errorCode: err instanceof ProviderError ? err.code : 'internal',
      };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { response, cleanup } = await this.send('GET', '/models', undefined, signal, false);
    try {
      if (!response.ok) throw await this.errorFromResponse(response, false);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProviderError('bad_stream', 'The model list was not valid JSON.');
      }
      const list = extractModelList(body);
      const ids = [...new Set(list)].sort((a, b) => a.localeCompare(b));
      return ids.map((id) => ({ id }));
    } catch (err) {
      throw this.normalizeError(err, signal);
    } finally {
      cleanup();
    }
  }

  // ───────────────────────── internals ─────────────────────────

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toWireMessage),
      stream: true,
    };
    const temperature = request.temperature ?? this.options.temperature;
    if (temperature !== undefined && !this.omitTemperature) body.temperature = temperature;
    const maxTokens = request.maxOutputTokens ?? this.options.maxOutputTokens;
    if (maxTokens !== undefined) {
      body[this.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    return body;
  }

  /** Some endpoints reject parameters others require. Adjust and retry once per parameter. */
  private learnFromBadRequest(message: string): boolean {
    const text = message.toLowerCase();
    if (!this.useMaxCompletionTokens && text.includes('max_tokens') && text.includes('max_completion_tokens')) {
      this.useMaxCompletionTokens = true;
      return true;
    }
    if (!this.omitTemperature && text.includes('temperature') && /unsupported|not supported|does not support|only the default/.test(text)) {
      this.omitTemperature = true;
      return true;
    }
    return false;
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    streaming: boolean,
  ): Promise<{ response: Response; cleanup: () => void; controller: AbortController; state: { timedOut: boolean } }> {
    if (signal?.aborted) throw new ProviderError('cancelled', 'Stopped.');
    const controller = new AbortController();
    const state = { timedOut: false };
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const headers: Record<string, string> = {
      Accept: streaming ? 'text/event-stream' : 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { response, cleanup, controller, state };
    } catch (err) {
      cleanup();
      if (state.timedOut) throw new ProviderError('timeout', 'The provider did not respond in time.');
      throw err;
    }
  }

  private async *streamOnce(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const hadTools = Boolean(request.tools && request.tools.length > 0);
    const { response, cleanup, controller } = await this.send(
      'POST',
      '/chat/completions',
      this.buildBody(request),
      signal,
      true,
    );

    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = this.options.idleTimeoutMs ?? this.options.timeoutMs;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, idleMs);
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!response.ok) throw await this.errorFromResponse(response, hadTools);

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (contentType.includes('application/json')) {
        // The endpoint ignored `stream: true` and answered in one piece.
        armIdle();
        const text = await response.text();
        yield* this.eventsFromJsonBody(text);
        return;
      }
      if (!response.body) throw new ProviderError('bad_stream', 'The provider sent an empty response.');

      reader = response.body.getReader();
      const parser = new SseParser();
      const acc = new StreamAccumulator();

      armIdle();
      for (;;) {
        const { done, value } = await reader.read();
        armIdle();
        const payloads = done ? parser.finish() : parser.push(value);
        for (const payload of payloads) {
          const text = acc.accept(payload, (m) => this.redact(m));
          if (text) yield { type: 'text', delta: text };
        }
        if (done || acc.sawDoneMarker) break;
      }
      yield* acc.finish();
    } catch (err) {
      if (idleTimedOut) throw new ProviderError('timeout', 'The provider stopped sending data.');
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      cleanup();
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // The stream is already closed or aborted.
        }
      }
    }
  }

  private *eventsFromJsonBody(text: string): Iterable<StreamEvent> {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError('bad_stream', 'The provider response was not valid JSON.');
    }
    const record = asRecord(body);
    if (record.error) throw errorFromPayload(record.error, (m) => this.redact(m));
    const choice = asRecord(asArray(record.choices)[0]);
    const message = asRecord(choice.message);
    const content = typeof message.content === 'string' ? message.content : '';
    if (content) yield { type: 'text', delta: content };
    const calls = asArray(message.tool_calls);
    let index = 0;
    for (const raw of calls) {
      const call = asRecord(raw);
      const fn = asRecord(call.function);
      if (typeof fn.name !== 'string' || !fn.name) continue;
      yield {
        type: 'tool_call',
        call: {
          id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`,
          name: fn.name,
          arguments: typeof fn.arguments === 'string' && fn.arguments ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
      };
      index += 1;
    }
    const usage = parseUsage(record.usage);
    if (usage) yield { type: 'usage', usage };
    if (!content && index === 0 && !choice.finish_reason) {
      throw new ProviderError('bad_stream', 'The provider response contained no message.');
    }
    yield { type: 'done', finishReason: mapFinishReason(choice.finish_reason, index > 0) };
  }

  private async errorFromResponse(response: Response, hadTools: boolean): Promise<ProviderError> {
    let raw = '';
    try {
      raw = (await response.text()).slice(0, MAX_ERROR_BODY);
    } catch {
      // Body unavailable; the status code alone is still useful.
    }
    let message = raw.trim();
    try {
      const parsed = asRecord(JSON.parse(raw));
      const inner = parsed.error;
      if (typeof inner === 'string') message = inner;
      else if (inner && typeof inner === 'object' && typeof asRecord(inner).message === 'string') {
        message = asRecord(inner).message as string;
      } else if (typeof parsed.message === 'string') message = parsed.message;
      else if (typeof parsed.detail === 'string') message = parsed.detail;
    } catch {
      // Not JSON. HTML error pages are not worth showing.
      if (/^\s*</.test(message)) message = '';
    }
    message = this.redact(message.replace(/\s+/g, ' ').slice(0, 400));

    const status = response.status;
    if (
      hadTools &&
      [400, 404, 422, 501].includes(status) &&
      /\b(tools?|functions?|tool_choice)\b/i.test(message) &&
      /support|unknown|unrecogni[sz]ed|invalid|not allowed|unexpected|extra|not permitted/i.test(message)
    ) {
      return new ProviderError('tools_unsupported', message, { status });
    }

    let code: ProviderErrorCode;
    if (status === 401 || status === 403) code = 'auth';
    else if (status === 404) code = 'not_found';
    else if (status === 408) code = 'timeout';
    else if (status === 429) code = 'rate_limit';
    else if (status >= 500) code = 'server';
    else code = 'bad_request';

    const retryAfter = Number(response.headers.get('retry-after'));
    return new ProviderError(code, message, {
      status,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
  }

  private normalizeError(err: unknown, signal?: AbortSignal): ProviderError {
    if (signal?.aborted) return new ProviderError('cancelled', 'Stopped.');
    if (err instanceof ProviderError) return err;
    if (err instanceof Error) {
      if (err.name === 'AbortError') return new ProviderError('cancelled', 'Stopped.');
      return new ProviderError('network', this.redact(networkMessage(err)));
    }
    return new ProviderError('network', this.redact(String(err)));
  }
}

/** Assembles streamed chunks into text deltas and complete tool calls. */
class StreamAccumulator {
  sawDoneMarker = false;
  private readonly calls = new Map<number, PendingToolCall>();
  private finishReason: unknown;
  private usage: TokenUsage | undefined;
  private parsedChunks = 0;
  private malformedChunks = 0;
  private textLength = 0;

  /** Returns the text delta carried by this payload, if any. */
  accept(payload: string, redact: (m: string) => string): string {
    const trimmed = payload.trim();
    if (!trimmed) return '';
    if (trimmed === '[DONE]') {
      this.sawDoneMarker = true;
      return '';
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = asRecord(JSON.parse(trimmed));
    } catch {
      this.malformedChunks += 1;
      return '';
    }
    this.parsedChunks += 1;
    if (chunk.error) throw errorFromPayload(chunk.error, redact);

    const usage = parseUsage(chunk.usage);
    if (usage) this.usage = usage;

    const choice = asRecord(asArray(chunk.choices)[0]);
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = asRecord(choice.delta);

    for (const raw of asArray(delta.tool_calls)) {
      const part = asRecord(raw);
      const index = typeof part.index === 'number' ? part.index : this.calls.size === 0 ? 0 : this.calls.size - 1;
      const fn = asRecord(part.function);
      const existing = this.calls.get(index) ?? { id: '', name: '', args: '' };
      if (typeof part.id === 'string' && part.id) existing.id = part.id;
      if (typeof fn.name === 'string' && fn.name) existing.name = existing.name || fn.name;
      if (typeof fn.arguments === 'string') existing.args += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') existing.args += JSON.stringify(fn.arguments);
      this.calls.set(index, existing);
    }

    const text = typeof delta.content === 'string' ? delta.content : '';
    this.textLength += text.length;
    return text;
  }

  *finish(): Iterable<StreamEvent> {
    const complete: ToolCall[] = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.args.trim() || '{}',
      }))
      .filter((call) => call.name);

    const ended = this.sawDoneMarker || Boolean(this.finishReason);
    if (!ended && this.textLength === 0 && complete.length === 0) {
      throw new ProviderError(
        'bad_stream',
        this.malformedChunks > 0
          ? 'The stream contained data that was not valid JSON.'
          : 'The stream ended before any content arrived.',
      );
    }

    for (const call of complete) yield { type: 'tool_call', call };
    if (this.usage) yield { type: 'usage', usage: this.usage };
    yield {
      type: 'done',
      finishReason: ended ? mapFinishReason(this.finishReason, complete.length > 0) : 'incomplete',
    };
  }
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant': {
      const wire: Record<string, unknown> = { role: 'assistant', content: message.content };
      if (message.toolCalls && message.toolCalls.length > 0) {
        if (!message.content) wire.content = null;
        wire.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return wire;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

function mapFinishReason(raw: unknown, hasToolCalls: boolean): FinishReason {
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool_calls';
  if (hasToolCalls) return 'tool_calls';
  if (raw === 'stop' || raw === 'end_turn' || raw === 'eos') return 'stop';
  if (raw === 'length' || raw === 'max_tokens') return 'length';
  if (raw === 'content_filter') return 'content_filter';
  return raw ? 'unknown' : 'stop';
}

function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  return {
    inputTokens: typeof input === 'number' ? input : 0,
    outputTokens: typeof output === 'number' ? output : 0,
  };
}

function errorFromPayload(raw: unknown, redact: (m: string) => string): ProviderError {
  const error = typeof raw === 'string' ? { message: raw } : asRecord(raw);
  const message = redact(String(error.message ?? 'The provider reported an error.').slice(0, 400));
  const kind = `${String(error.type ?? '')} ${String(error.code ?? '')}`.toLowerCase();
  let code: ProviderErrorCode = 'server';
  if (/rate|quota|overload/.test(kind)) code = 'rate_limit';
  else if (/auth|permission|api_key|key/.test(kind)) code = 'auth';
  else if (/invalid|bad_request|context_length/.test(kind)) code = 'bad_request';
  return new ProviderError(code, message);
}

function extractModelList(body: unknown): string[] {
  const record = asRecord(body);
  const source = Array.isArray(body) ? body : Array.isArray(record.data) ? record.data : asArray(record.models);
  const ids: string[] = [];
  for (const entry of source) {
    if (typeof entry === 'string') ids.push(entry);
    else {
      const item = asRecord(entry);
      const id = item.id ?? item.name ?? item.model;
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  return ids;
}

function networkMessage(err: Error): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? '';
  if (code === 'ECONNREFUSED') return 'Connection refused. Is the server running?';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The host name could not be resolved.';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'The connection was closed unexpectedly.';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'Connecting to the provider timed out.';
  if (/CERT|SSL|TLS/i.test(code)) return `Secure connection failed (${code}).`;
  return cause?.message ?? err.message ?? 'Network error.';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('cancelled', 'Stopped.'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ProviderError('cancelled', 'Stopped.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
