import type { ChatItem, ChatItemPatch, UsageView } from '../shared/protocol';

/**
 * Where the runtime reports what it is doing. The chat controller turns
 * these calls into transcript updates; tests record them.
 */
export interface AgentEvents {
  add(item: ChatItem): void;
  update(id: string, patch: ChatItemPatch): void;
  appendText(id: string, delta: string): void;
  usage(usage: UsageView): void;
}

/**
 * Everything the runtime needs from a human or the editor. Approval is the
 * return value of these calls, so there is no path that skips it.
 */
export interface AgentHost {
  /** Asks the user to confirm the context shown in the given transcript item. */
  confirmContext(requestId: string, signal: AbortSignal): Promise<boolean>;
}

/** One completed exchange, kept so later prompts have conversation context. */
export interface Turn {
  user: string;
  assistant: string;
  /** Short factual record of actions taken (files changed, commands run). */
  notes?: string;
}
