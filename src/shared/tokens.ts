/**
 * Conservative token estimates. Real tokenizers differ per model, so these
 * deliberately over-count: running slightly under budget is safe, running
 * over it is not.
 */

const CHARS_PER_TOKEN = 3.2;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Non-ASCII text usually costs more tokens per character.
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) wide += 1;
  return Math.ceil((text.length - wide) / CHARS_PER_TOKEN + wide);
}

/** Overhead per chat message for role markers and separators. */
export const MESSAGE_OVERHEAD_TOKENS = 6;

export function estimateMessagesTokens(messages: Array<{ content: string; toolCalls?: Array<{ name: string; arguments: string }> }>): number {
  let total = 0;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content);
    for (const call of message.toolCalls ?? []) total += 8 + estimateTokens(call.name) + estimateTokens(call.arguments);
  }
  return total;
}

/** Cuts text to roughly `maxTokens`, on a line boundary where possible. */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  let cut = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  while (cut > 0 && estimateTokens(text.slice(0, cut)) > maxTokens) cut = Math.floor(cut * 0.9);
  const newline = text.lastIndexOf('\n', cut);
  if (newline > cut * 0.6) cut = newline;
  return { text: text.slice(0, cut), truncated: true };
}
