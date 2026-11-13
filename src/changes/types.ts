import type { ChangeKind } from '../shared/protocol';

/** What the model asks for. Normalised into ProposedChange before review. */
export type ChangeOperation =
  | { type: 'write'; path: string; content: string }
  | { type: 'edit'; path: string; edits: Array<{ search: string; replace: string; replaceAll?: boolean }> }
  | { type: 'delete'; path: string };

/** One file's change, with everything needed to review and safely apply it. */
export interface ProposedChange {
  id: string;
  /** Workspace-relative path with forward slashes. */
  path: string;
  kind: ChangeKind;
  /** Hash of the content this change was computed from (ABSENT_HASH for new files). */
  baseHash: string;
  /** Content the change was computed from; null when the file did not exist. */
  baseContent: string | null;
  /** Exact content to write; null for a deletion. */
  newContent: string | null;
  added: number;
  removed: number;
}

export interface ChangeSet {
  id: string;
  summary: string;
  changes: ProposedChange[];
  createdAt: number;
}

export type Decision = 'accept' | 'reject';

export interface ReviewDecision {
  decisions: Record<string, Decision>;
  /** Text from "ask for changes"; the model should revise. */
  feedback?: string;
}

export type ApplyStatus = 'applied' | 'rejected' | 'stale' | 'failed';

export interface ApplyResult {
  changeId: string;
  path: string;
  kind: ChangeKind;
  status: ApplyStatus;
  error?: string;
}

/** How approved content reaches the workspace. Editor-aware in VS Code. */
export interface ChangeIO {
  write(relativePath: string, content: string): Promise<void>;
  delete(relativePath: string): Promise<void>;
}
