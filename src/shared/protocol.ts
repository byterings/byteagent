/**
 * Types shared by the extension host and the webview. This file must stay
 * free of runtime imports so both bundles can use it.
 */

export type ExecutionMode = 'quick' | 'standard' | 'project';
export type ModeSetting = 'auto' | ExecutionMode;
export type ToolCallingMode = 'auto' | 'native' | 'text';

// ───────────────────────── Provider settings ─────────────────────────

export interface ProfileView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  timeoutSeconds?: number;
  toolCalling?: ToolCallingMode;
  /** Whether a key is stored. The key itself never reaches the webview. */
  hasKey: boolean;
}

/** A profile being created or edited. `id` is empty for a new profile. */
export interface ProfileDraft {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  temperature?: number | string;
  maxOutputTokens?: number | string;
  contextWindow?: number | string;
  timeoutSeconds?: number | string;
  toolCalling?: ToolCallingMode;
}

export interface PresetView {
  id: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  modelHint: string;
  keyHelpUrl?: string;
}

export interface FieldProblem {
  field: string;
  message: string;
}

// ───────────────────────── Chat transcript ─────────────────────────

export interface Attachment {
  /** Workspace-relative path with forward slashes. */
  path: string;
  /** 1-based inclusive line range, when only part of the file is attached. */
  startLine?: number;
  endLine?: number;
  source: 'mention' | 'selection' | 'active';
}

export interface ContextFileView {
  path: string;
  reason: string;
  tokens: number;
  truncated?: boolean;
  startLine?: number;
  endLine?: number;
}

export interface OmittedView {
  path: string;
  reason: string;
}

export type ChangeKind = 'create' | 'modify' | 'delete';
export type ChangeStatus = 'pending' | 'accepted' | 'rejected' | 'applied' | 'stale' | 'failed';

export interface ChangeFileView {
  changeId: string;
  path: string;
  kind: ChangeKind;
  added: number;
  removed: number;
  status: ChangeStatus;
  error?: string;
}

export type CommandRisk = 'safe' | 'moderate' | 'destructive';
export type CommandStatus = 'pending' | 'running' | 'done' | 'denied' | 'timeout' | 'cancelled' | 'error';

export interface PlanStepView {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';
}

export interface OutcomeView {
  applied: string[];
  rejected: string[];
  failed: Array<{ path: string; error: string }>;
  commands: Array<{ command: string; exitCode: number | null; passed: boolean; verification: boolean }>;
  diagnostics: { errors: number; warnings: number; files: string[] } | null;
  /** Built only from recorded evidence. */
  verification: 'passed' | 'failed' | 'not_run';
  notes: string[];
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string; attachments: Attachment[]; mode: ModeSetting }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'classification';
      id: string;
      mode: ExecutionMode;
      auto: boolean;
      reasons: string[];
      confidence: number;
      escalatedFrom?: ExecutionMode;
    }
  | {
      kind: 'context';
      id: string;
      files: ContextFileView[];
      omitted: OmittedView[];
      totalTokens: number;
      budget: number;
      /** Set while the user is asked to confirm before sending. */
      confirm?: { requestId: string; status: 'pending' | 'sent' | 'cancelled' };
    }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      title: string;
      status: 'running' | 'done' | 'error';
      detail?: string;
      path?: string;
    }
  | {
      kind: 'changes';
      id: string;
      changeSetId: string;
      summary: string;
      files: ChangeFileView[];
      status: 'pending' | 'resolved';
      feedback?: string;
    }
  | {
      kind: 'command';
      id: string;
      requestId: string;
      command: string;
      purpose: string;
      risk: CommandRisk;
      riskReasons: string[];
      canRemember: boolean;
      remembered: boolean;
      status: CommandStatus;
      verification: boolean;
      exitCode?: number | null;
      durationMs?: number;
      output?: string;
    }
  | { kind: 'plan'; id: string; taskId?: string; goal: string; steps: PlanStepView[]; criteria: string[] }
  | { kind: 'outcome'; id: string; outcome: OutcomeView }
  | { kind: 'notice'; id: string; level: 'info' | 'warn'; text: string }
  | { kind: 'error'; id: string; message: string; code?: string; canRetry?: boolean; openSettings?: boolean };

export type ChatItemPatch = Partial<Record<string, unknown>>;

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface TaskSummary {
  id: string;
  title: string;
  mode: ExecutionMode;
  status: string;
  updatedAt: number;
  stepsDone: number;
  stepsTotal: number;
}

export interface UsageView {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export interface EditorContext {
  activeFile?: string;
  selection?: { path: string; startLine: number; endLine: number };
}

export type ViewName = 'chat' | 'settings' | 'history';

export interface AppState {
  ready: boolean;
  hasWorkspace: boolean;
  workspaceName: string;
  profiles: ProfileView[];
  activeProfileId: string;
  presets: PresetView[];
  settingsProblems: Array<{ setting: string; message: string }>;
  defaultMode: ModeSetting;
  sessions: SessionSummary[];
  sessionId: string;
  items: ChatItem[];
  busy: boolean;
  usage: UsageView | null;
  tasks: TaskSummary[];
  projectInitialized: boolean;
  editor: EditorContext;
}

// ───────────────────────── Messages ─────────────────────────

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; text: string; mode: ModeSetting; attachments: Attachment[] }
  | { type: 'stop' }
  | { type: 'retry' }
  | { type: 'newChat' }
  | { type: 'openSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | {
      type: 'saveProfile';
      requestId: string;
      draft: ProfileDraft;
      /** string = store, null = remove, undefined = keep existing. */
      apiKey?: string | null;
      makeActive: boolean;
    }
  | { type: 'deleteProfile'; id: string }
  | { type: 'setActiveProfile'; id: string }
  | { type: 'setModel'; model: string }
  | { type: 'setMode'; mode: ModeSetting }
  | { type: 'testConnection'; requestId: string; draft: ProfileDraft; apiKey?: string | null }
  | { type: 'listModels'; requestId: string; draft: ProfileDraft; apiKey?: string | null }
  | {
      type: 'reviewDecision';
      changeSetId: string;
      decisions: Record<string, 'accept' | 'reject'>;
      feedback?: string;
    }
  | { type: 'openDiff'; changeSetId: string; changeId: string }
  | { type: 'commandDecision'; requestId: string; decision: 'once' | 'always' | 'deny' }
  | { type: 'contextDecision'; requestId: string; send: boolean }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openExternal'; url: string }
  | { type: 'searchFiles'; requestId: string; query: string }
  | { type: 'resumeTask'; taskId: string }
  | { type: 'initProject' }
  | { type: 'copy'; text: string }
  | { type: 'openVsCodeSettings' };

export type HostMessage =
  | { type: 'state'; state: AppState }
  | { type: 'itemAdded'; sessionId: string; item: ChatItem }
  | { type: 'itemUpdated'; sessionId: string; id: string; patch: ChatItemPatch }
  | { type: 'textDelta'; sessionId: string; id: string; delta: string }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'usage'; sessionId: string; usage: UsageView }
  | {
      type: 'profileSaved';
      requestId: string;
      ok: boolean;
      errors: FieldProblem[];
      warnings: FieldProblem[];
      profileId?: string;
    }
  | {
      type: 'connectionResult';
      requestId: string;
      ok: boolean;
      message: string;
      latencyMs?: number;
      errors?: FieldProblem[];
    }
  | { type: 'models'; requestId: string; models: string[]; error?: string }
  | { type: 'fileSuggestions'; requestId: string; files: string[] }
  | { type: 'editorContext'; editor: EditorContext }
  | { type: 'addAttachment'; attachment: Attachment }
  | { type: 'showView'; view: ViewName }
  | { type: 'focusInput' }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string };
