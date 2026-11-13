/**
 * The provider contract. The agent runtime depends only on these types;
 * nothing vendor-specific may appear here. See docs/provider-contract.md.
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text exactly as the model produced it. Validated by the tool registry. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name?: string; content: string };

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'incomplete' | 'unknown';

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: FinishReason };

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  finishReason: FinishReason;
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: 'native' | 'none' | 'unknown';
  structuredOutput: boolean;
  embeddings: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  errorCode?: string;
}

export interface ModelInfo {
  id: string;
}

export interface Provider {
  /** Profile id this provider was built from. */
  readonly id: string;
  readonly model: string;
  getCapabilities(): ProviderCapabilities;
  stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

/** Collects a stream into a single response. Shared by every adapter. */
export async function collectStream(events: AsyncIterable<StreamEvent>): Promise<ChatResponse> {
  let content = '';
  const toolCalls: ToolCall[] = [];
  let usage: TokenUsage | undefined;
  let finishReason: FinishReason = 'unknown';
  for await (const event of events) {
    switch (event.type) {
      case 'text':
        content += event.delta;
        break;
      case 'tool_call':
        toolCalls.push(event.call);
        break;
      case 'usage':
        usage = event.usage;
        break;
      case 'done':
        finishReason = event.finishReason;
        break;
    }
  }
  return { content, toolCalls, usage, finishReason };
}
