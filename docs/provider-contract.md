# Provider Contract

The provider layer turns a normalised chat request into a vendor HTTP call
and turns the vendor response back into normalised events. The agent runtime
depends only on the types in `src/providers/types.ts`.

## 1. Interface

```ts
interface Provider {
  readonly id: string;
  getCapabilities(): ProviderCapabilities;
  stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}
```

`chat()` is implemented by consuming `stream()`, so both paths share one
parser.

## 2. Normalised request

```ts
interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];          // omitted when the provider cannot call tools
  temperature?: number;
  maxOutputTokens?: number;
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

interface ToolSpec { name: string; description: string; parameters: JsonSchema; }
interface ToolCall { id: string; name: string; arguments: string; } // raw JSON text
```

Tool-call arguments stay as raw text in the provider layer. The tool
registry parses and validates them, so a malformed argument is a tool error
and never a provider crash.

## 3. Normalised stream events

```ts
type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }      // emitted once, fully assembled
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: FinishReason };
```

Rules:

- Partial tool-call fragments are assembled inside the adapter. The runtime
  only sees complete calls.
- A stream that ends without a terminal marker yields `done` with
  `finishReason: 'incomplete'` when some content arrived, and throws
  `ProviderError('bad_stream')` when nothing arrived.
- An error object inside the stream body throws a `ProviderError`.

## 4. Capabilities

```ts
interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: 'native' | 'none' | 'unknown';
  structuredOutput: boolean;
  embeddings: boolean;
  contextWindow?: number;      // tokens, when known
  maxOutputTokens?: number;
}
```

A compatible URL does not guarantee every feature. Behaviour when a feature
is missing:

| Missing feature | Behaviour |
|---|---|
| Tool calling (`none`) | The runtime uses the text tool protocol (`src/agent/textTools.ts`) |
| Tool calling (`unknown`) | Native tools are tried first. If the endpoint rejects the `tools` field, the runtime switches to the text protocol for the rest of the session |
| Model listing | `listModels()` returns an empty list and the UI accepts a typed model name |
| Context window unknown | A conservative default from settings is used |

## 5. Errors

All failures are `ProviderError` with a stable `code`:

| Code | Typical cause | Retried |
|---|---|---|
| `auth` | 401 / 403 | No |
| `not_found` | 404, wrong base URL or model | No |
| `rate_limit` | 429 | Yes, bounded |
| `server` | 5xx | Yes, bounded |
| `bad_request` | 400, 422 | No |
| `network` | DNS, refused connection, TLS | Yes, bounded |
| `timeout` | No response within the configured time | No |
| `cancelled` | User pressed Stop | No |
| `bad_stream` | Unparseable or empty stream | No |
| `tools_unsupported` | Endpoint rejected the `tools` field | Triggers fallback |

Retries happen only before the first byte of a response is delivered to the
runtime, at most twice, with backoff, and stop immediately on cancellation.

Error messages shown to the user never include the API key, the
`Authorization` header, or a full request body. Response bodies from the
provider are truncated and passed through the redactor before display.

## 6. Timeouts and cancellation

- Every call accepts an `AbortSignal`. Aborting it closes the HTTP stream.
- `timeoutMs` covers the time to the first byte. A separate idle timeout
  aborts a stream that stops sending data.
- Cancellation surfaces as `ProviderError('cancelled')`, never as a generic
  failure.

## 7. The OpenAI-compatible adapter

`src/providers/openaiCompatible.ts` targets the widely implemented
`POST {baseUrl}/chat/completions` server-sent-events protocol and
`GET {baseUrl}/models`.

- Base URL is normalised: trailing slashes and a pasted
  `/chat/completions` suffix are removed.
- Only `http` and `https` are accepted. Plain `http` to a non-local host
  produces a warning because the key would travel unencrypted.
- The API key is optional, because local servers often need none.
- Only fields that are broadly supported are sent: `model`, `messages`,
  `stream`, `temperature`, `max_tokens`, `tools`.

## 8. Adding a native adapter later

A new adapter implements `Provider` and registers a factory in
`src/providers/factory.ts`. It must not change any type in
`src/providers/types.ts` to fit a vendor. Vendor SDK types stay inside the
adapter file.
