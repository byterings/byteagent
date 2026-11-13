import type { Provider, ChatMessage } from '../providers/types';
import { describeError, isCancellation, ProviderError } from '../shared/errors';
import { newId } from '../shared/hash';
import type { Logger } from '../shared/logger';
import type { Attachment, ExecutionMode, ModeSetting } from '../shared/protocol';
import { estimateMessagesTokens, estimateTokens } from '../shared/tokens';
import type { AgentEvents, Turn } from './host';
import { buildSystemPrompt } from './prompts';

export interface RunRequest {
  prompt: string;
  attachments: Attachment[];
  mode: ModeSetting;
  history: Turn[];
  workspaceName?: string;
}

export interface RunResult {
  status: 'completed' | 'cancelled' | 'failed';
  assistantText: string;
  /** Present when the exchange should be remembered for later prompts. */
  turn?: Turn;
  errorCode?: string;
}

export interface RuntimeDeps {
  provider: Provider;
  events: AgentEvents;
  logger: Logger;
}

/** How much earlier conversation is replayed to the model, newest first. */
const HISTORY_TOKEN_BUDGET = 6000;

/**
 * Runs one user request against the provider. This is the only place that
 * drives the model; everything it does is reported through AgentEvents.
 */
export class AgentRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  async run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
    const { provider, events, logger } = this.deps;
    const mode: ExecutionMode = request.mode === 'auto' ? 'quick' : request.mode;

    events.add({
      kind: 'user',
      id: newId('u'),
      text: request.prompt,
      attachments: request.attachments,
      mode: request.mode,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt({ mode, workspaceName: request.workspaceName, toolNames: [] }) },
      ...historyMessages(request.history, HISTORY_TOKEN_BUDGET),
      { role: 'user', content: request.prompt },
    ];

    const assistantId = newId('a');
    events.add({ kind: 'assistant', id: assistantId, text: '', streaming: true });

    let text = '';
    let reportedUsage = false;
    try {
      for await (const event of provider.stream({ messages }, signal)) {
        if (event.type === 'text') {
          text += event.delta;
          events.appendText(assistantId, event.delta);
        } else if (event.type === 'usage') {
          reportedUsage = true;
          events.usage({ ...event.usage, estimated: false });
        } else if (event.type === 'done' && event.finishReason === 'length') {
          events.add({ kind: 'notice', id: newId('n'), level: 'warn', text: 'The reply was cut off because it reached the output limit.' });
        } else if (event.type === 'done' && event.finishReason === 'incomplete') {
          events.add({ kind: 'notice', id: newId('n'), level: 'warn', text: 'The connection ended before the reply was complete.' });
        }
      }
      events.update(assistantId, { streaming: false });
      if (!reportedUsage) {
        events.usage({ inputTokens: estimateMessagesTokens(messages), outputTokens: estimateTokens(text), estimated: true });
      }
      if (!text.trim()) {
        events.add({ kind: 'notice', id: newId('n'), level: 'warn', text: 'The model returned an empty reply.' });
        return { status: 'completed', assistantText: '' };
      }
      return { status: 'completed', assistantText: text, turn: { user: request.prompt, assistant: text } };
    } catch (err) {
      events.update(assistantId, { streaming: false });
      if (isCancellation(err)) {
        events.add({ kind: 'notice', id: newId('n'), level: 'info', text: 'Stopped.' });
        return {
          status: 'cancelled',
          assistantText: text,
          turn: text.trim() ? { user: request.prompt, assistant: `${text}\n[stopped by the user]` } : undefined,
        };
      }
      logger.error('Run failed', err);
      const code = err instanceof ProviderError ? err.code : 'internal';
      events.add({
        kind: 'error',
        id: newId('e'),
        message: describeError(err),
        code,
        canRetry: true,
        openSettings: code === 'auth' || code === 'not_found' || code === 'network',
      });
      return { status: 'failed', assistantText: text, errorCode: code };
    }
  }
}

/** Replays as many recent turns as fit in the budget, oldest first. */
export function historyMessages(history: Turn[], budget: number): ChatMessage[] {
  const picked: Turn[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i] as Turn;
    const cost = estimateTokens(turn.user) + estimateTokens(turn.assistant) + estimateTokens(turn.notes ?? '') + 12;
    if (used + cost > budget && picked.length > 0) break;
    if (cost > budget) break;
    picked.unshift(turn);
    used += cost;
  }
  return picked.flatMap((turn): ChatMessage[] => [
    { role: 'user', content: turn.user },
    { role: 'assistant', content: turn.notes ? `${turn.assistant}\n\n[Recorded actions]\n${turn.notes}` : turn.assistant },
  ]);
}
