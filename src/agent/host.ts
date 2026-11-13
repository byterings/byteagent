import type { ChangeIO, ChangeSet, ReviewDecision } from '../changes/types';
import type { ChatItem, ChatItemPatch, CommandRisk, UsageView } from '../shared/protocol';

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

export interface CommandRequest {
  requestId: string;
  command: string;
  risk: CommandRisk;
  reasons: string[];
  canRemember: boolean;
}

export type CommandDecision = 'once' | 'always' | 'deny';

export interface DiagnosticSummary {
  errors: number;
  warnings: number;
  /** Files that have at least one error. */
  files: string[];
}

/**
 * Everything the runtime needs from a human or the editor. Approval is the
 * return value of these calls, so there is no path that skips it.
 */
export interface AgentHost {
  /** Asks the user to confirm the context shown in the given transcript item. */
  confirmContext(requestId: string, signal: AbortSignal): Promise<boolean>;
  /**
   * Shows a change set for review and waits for the decision. A stopped
   * run must resolve with every file rejected.
   */
  reviewChanges(changeSet: ChangeSet, signal: AbortSignal): Promise<ReviewDecision>;
  /** How approved changes are written (editor-aware inside VS Code). */
  changeIO: ChangeIO;
  /**
   * Asks the user whether a command may run. A stopped run must resolve
   * with "deny". Approving a file change never answers this question.
   */
  approveCommand(request: CommandRequest, signal: AbortSignal): Promise<CommandDecision>;
  /** True when the user chose "always allow" for this exact command in this workspace. */
  isCommandRemembered(command: string): boolean;
  rememberCommand(command: string): Promise<void>;
  /** Longest time an approved command may run. */
  commandTimeoutMs: number;
  /** Editor diagnostics for the given files, or null when unavailable. */
  getDiagnostics(paths: string[]): Promise<DiagnosticSummary | null>;
}

/** One completed exchange, kept so later prompts have conversation context. */
export interface Turn {
  user: string;
  assistant: string;
  /** Short factual record of actions taken (files changed, commands run). */
  notes?: string;
}
