import type { AgentEvents, AgentHost } from '../agent/host';
import type { WorkspaceIndex } from '../context/workspaceIndex';
import type { Logger } from '../shared/logger';
import type { SchemaNode } from './schema';

/**
 * What a tool is allowed to do. The runtime decides which classes are
 * permitted; a tool cannot raise its own class.
 *
 * - read: looks at allowed workspace content, changes nothing
 * - propose: prepares file changes that the user must approve
 * - execute: runs a command that the user must approve
 */
export type PermissionClass = 'read' | 'propose' | 'execute';

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  durationMs: number;
  status: 'done' | 'denied' | 'timeout' | 'cancelled' | 'error';
  /** True when the command was run to check the work (tests, build, lint). */
  verification: boolean;
  outputSummary: string;
}

/** Facts recorded during a run. The outcome summary is built only from these. */
export interface RunRecord {
  applied: string[];
  rejected: string[];
  stale: string[];
  failed: Array<{ path: string; error: string }>;
  commands: CommandRecord[];
  filesRead: Set<string>;
  proposals: number;
  /** Feedback the user gave while reviewing changes. */
  feedback: string[];
}

export function newRunRecord(): RunRecord {
  return { applied: [], rejected: [], stale: [], failed: [], commands: [], filesRead: new Set(), proposals: 0, feedback: [] };
}

export interface ToolContext {
  index: WorkspaceIndex;
  ripgrepPath?: string;
  signal: AbortSignal;
  host: AgentHost;
  events: AgentEvents;
  record: RunRecord;
  logger: Logger;
  redact(text: string): string;
}

export interface ToolOutcome {
  ok: boolean;
  /** Text returned to the model. */
  content: string;
  /** Short note for the activity row, for example "48 lines". */
  detail?: string;
}

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: SchemaNode;
  permission: PermissionClass;
  /** False for tools that draw their own card (change review, commands). */
  showsRow: boolean;
  /** Label for the activity row, from validated arguments. */
  describe(args: A): { title: string; path?: string };
  execute(args: A, context: ToolContext): Promise<ToolOutcome>;
}
