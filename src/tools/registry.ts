import type { ToolCall, ToolSpec } from '../providers/types';
import { ByteAgentError, isCancellation } from '../shared/errors';
import { newId } from '../shared/hash';
import { estimateTokens, truncateToTokens } from '../shared/tokens';
import { validateArguments } from './schema';
import type { PermissionClass, ToolContext, ToolDefinition } from './types';

export interface InvokeResult {
  ok: boolean;
  content: string;
}

/** Largest tool result passed back to the model, in estimated tokens. */
export const MAX_TOOL_RESULT_TOKENS = 6000;

/**
 * The single entry point for tool execution. Unknown tools, disallowed
 * permission classes and invalid arguments are refused here, before any
 * tool code runs.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any>>();

  register<A>(tool: ToolDefinition<A>): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  names(allowed?: ReadonlySet<PermissionClass>): string[] {
    return [...this.tools.values()].filter((t) => !allowed || allowed.has(t.permission)).map((t) => t.name);
  }

  /** Tool descriptions to send to the model, limited to the allowed classes. */
  specs(allowed: ReadonlySet<PermissionClass>): ToolSpec[] {
    return [...this.tools.values()]
      .filter((t) => allowed.has(t.permission))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> }));
  }

  async invoke(call: ToolCall, context: ToolContext, allowed: ReadonlySet<PermissionClass>): Promise<InvokeResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { ok: false, content: `Error: there is no tool named "${call.name}". Available tools: ${this.names(allowed).join(', ')}.` };
    }
    // Enforced here, in code, whatever the prompt said.
    if (!allowed.has(tool.permission)) {
      context.logger.warn(`Blocked tool "${tool.name}": permission class "${tool.permission}" is not allowed in this run`);
      return { ok: false, content: `Error: the tool "${tool.name}" is not permitted in this conversation.` };
    }

    let parsed: unknown;
    const raw = call.arguments.trim();
    try {
      parsed = raw === '' ? {} : JSON.parse(raw);
    } catch {
      return { ok: false, content: `Error: the arguments for "${tool.name}" were not valid JSON. Send a single JSON object.` };
    }
    const validation = validateArguments(tool.parameters, parsed);
    if (!validation.ok) {
      return { ok: false, content: `Error: invalid arguments for "${tool.name}":\n- ${validation.errors.join('\n- ')}` };
    }
    const args = validation.value as Record<string, unknown>;

    let rowId: string | undefined;
    if (tool.showsRow) {
      const label = tool.describe(args);
      rowId = newId('t');
      context.events.add({ kind: 'tool', id: rowId, tool: tool.name, title: label.title, status: 'running', path: label.path });
    }

    try {
      if (context.signal.aborted) throw new ByteAgentError('cancelled', 'Stopped.');
      const outcome = await tool.execute(args, context);
      if (rowId) context.events.update(rowId, { status: outcome.ok ? 'done' : 'error', detail: outcome.detail });
      return { ok: outcome.ok, content: limitResult(context.redact(outcome.content)) };
    } catch (err) {
      if (isCancellation(err)) {
        if (rowId) context.events.update(rowId, { status: 'error', detail: 'stopped' });
        throw err;
      }
      const message = err instanceof ByteAgentError ? err.message : 'The tool failed unexpectedly.';
      if (!(err instanceof ByteAgentError)) context.logger.error(`Tool "${tool.name}" failed`, err);
      if (rowId) context.events.update(rowId, { status: 'error', detail: shortReason(err) });
      return { ok: false, content: `Error: ${context.redact(message)}` };
    }
  }
}

function shortReason(err: unknown): string {
  if (!(err instanceof ByteAgentError)) return 'failed';
  switch (err.code) {
    case 'path_sensitive':
      return 'blocked: sensitive file';
    case 'path_excluded':
      return 'blocked: excluded';
    case 'path_outside_workspace':
      return 'blocked: outside workspace';
    case 'not_found':
      return 'not found';
    case 'file_too_large':
      return 'too large';
    case 'binary_file':
      return 'binary file';
    default:
      return 'failed';
  }
}

function limitResult(content: string): string {
  if (estimateTokens(content) <= MAX_TOOL_RESULT_TOKENS) return content;
  const cut = truncateToTokens(content, MAX_TOOL_RESULT_TOKENS);
  return `${cut.text}\n[Output shortened: it was longer than the limit. Narrow the request to see the rest.]`;
}
