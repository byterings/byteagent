import type { ChatMessage, ToolCall, ToolSpec } from '../providers/types';

/**
 * Tool calling for endpoints without native support: the model writes its
 * calls as fenced blocks in plain text, and results go back as a user
 * message.
 */

const BLOCK = /```tool_call[^\S\n]*\n([\s\S]*?)```|<tool_call>([\s\S]*?)<\/tool_call>/g;

export function toolInstructions(tools: ToolSpec[]): string {
  const list = tools
    .map((tool) => `### ${tool.name}\n${tool.description}\nArguments (JSON Schema): ${JSON.stringify(tool.parameters)}`)
    .join('\n\n');
  return [
    'Tool use in this conversation works through text.',
    'To call a tool, write a block exactly in this form, then stop writing and wait for the result:',
    '```tool_call\n{"name": "read_file", "arguments": {"path": "src/app.ts"}}\n```',
    'Rules: the block must contain one JSON object with "name" and "arguments". You may write several blocks in one message. Do not invent tool results; they arrive in the next message. When you need no more tools, answer normally without any block.',
    `Available tools:\n\n${list}`,
  ].join('\n\n');
}

export interface ParsedToolText {
  calls: ToolCall[];
  /** The message with the tool blocks removed, for display. */
  cleaned: string;
  /** Problems to report back to the model. */
  errors: string[];
}

export function parseTextToolCalls(text: string, idPrefix: string): ParsedToolText {
  const calls: ToolCall[] = [];
  const errors: string[] = [];
  let index = 0;
  const cleaned = text.replace(BLOCK, (_match, fenced: string | undefined, tagged: string | undefined) => {
    const body = (fenced ?? tagged ?? '').trim();
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const name = parsed.name ?? parsed.tool;
      const args = parsed.arguments ?? parsed.args ?? parsed.parameters ?? {};
      if (typeof name !== 'string' || !name) {
        errors.push('A tool_call block had no "name".');
      } else {
        calls.push({ id: `${idPrefix}_${index}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
        index += 1;
      }
    } catch {
      errors.push('A tool_call block was not valid JSON. Write one JSON object with "name" and "arguments".');
    }
    return '';
  });
  return { calls, cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim(), errors };
}

function renderCall(call: ToolCall): string {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    args = {};
  }
  return `\`\`\`tool_call\n${JSON.stringify({ name: call.name, arguments: args })}\n\`\`\``;
}

/** Rewrites a native-style conversation into plain text messages. */
export function toTextProtocol(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let results: string[] = [];
  const flush = (): void => {
    if (results.length === 0) return;
    out.push({ role: 'user', content: `Tool results:\n\n${results.join('\n\n')}\n\nContinue.` });
    results = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      results.push(`[${message.name ?? 'tool'}]\n${message.content}`);
      continue;
    }
    flush();
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const blocks = message.toolCalls.map(renderCall).join('\n');
      out.push({ role: 'assistant', content: message.content ? `${message.content}\n${blocks}` : blocks });
    } else {
      out.push(message);
    }
  }
  flush();
  return out;
}
