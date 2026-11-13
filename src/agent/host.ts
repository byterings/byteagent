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

/** One completed exchange, kept so later prompts have conversation context. */
export interface Turn {
  user: string;
  assistant: string;
  /** Short factual record of actions taken (files changed, commands run). */
  notes?: string;
}
