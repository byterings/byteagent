import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentEvents, AgentHost, CommandDecision, CommandRequest, DiagnosticSummary } from '../agent/host';
import { buildOutcome } from '../agent/outcome';
import type { ChangeIO, ChangeSet, ReviewDecision } from '../changes/types';
import { ChangeReviewService } from '../changes/vscodeReview';
import { AgentRuntime } from '../agent/runtime';
import { isOpen, MemoryTaskTracker, taskProgress, type TaskState, type TaskTracker } from '../agent/taskState';
import { findActiveProfile, PROVIDER_PRESETS, type ProviderProfile } from '../config/settings';
import { findFiles } from '../context/search';
import { writeDefaultMode } from '../config/vscodeSettings';
import { createProvider } from '../providers/factory';
import type { Provider } from '../providers/types';
import { renderTaskSection, syncStatusDocument } from '../project/docsSync';
import { CONTEXT_FILE, describeBaseline, IGNORE_FILE, KNOWLEDGE_DIR, planOnboarding, STATUS_FILE } from '../project/onboarding';
import { ProjectStore } from '../project/store';
import { describeError } from '../shared/errors';
import { createToolRegistry, type ToolRegistry } from '../tools';
import { proposeChangesTool } from '../tools/builtin/proposeChanges';
import { newRunRecord, type RunRecord, type ToolContext } from '../tools/types';
import { newId, sha256 } from '../shared/hash';
import type {
  AppState,
  Attachment,
  ChatItem,
  ChatItemPatch,
  HostMessage,
  ModeSetting,
  ProfileDraft,
  UsageView,
  ViewName,
  WebviewMessage,
} from '../shared/protocol';
import { SessionStore, titleFromPrompt, type Session } from './sessionStore';
import { workspaceName, workspaceRoot, type Services } from './services';
import { VsCodeChangeIO } from './vscodeChangeIO';

export type Poster = (message: HostMessage) => void;

interface PromptInput {
  text: string;
  mode: ModeSetting;
  attachments: Attachment[];
  /** Continue this saved task. */
  resumeTaskId?: string;
}

export interface InitProjectOptions {
  /** What the project should do, for a workspace without code. */
  requirements?: string;
  /** Also create AGENTS.md. Only on explicit request. */
  includeAgentsFile?: boolean;
}

const MAX_TURNS = 40;
const REMEMBERED_COMMANDS_KEY = 'byteagent.rememberedCommands';
const DIAGNOSTICS_SETTLE_MS = 700;
const DELTA_FLUSH_MS = 24;

/**
 * Bridges the webview and the rest of the extension. All webview messages
 * arrive here; all state the webview shows is produced here.
 */
export class ChatController implements AgentEvents, AgentHost {
  private poster: Poster | undefined;
  private pendingView: ViewName | undefined;
  private readonly sessions: SessionStore;
  private session: Session;
  private busy = false;
  private abort: AbortController | undefined;
  private lastPrompt: PromptInput | undefined;
  private providerCache: { signature: string; provider: Provider } | undefined;
  private readonly pendingText = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves when the current run has fully finished. Used by tests. */
  private runPromise: Promise<void> = Promise.resolve();
  /** Questions waiting for the user's answer, by request id. */
  private readonly pending = new Map<string, (answer: unknown) => void>();
  private readonly review = new ChangeReviewService();
  private tasks: TaskTracker = new MemoryTaskTracker();
  private store: ProjectStore | undefined;
  private storeReady: Promise<void>;
  /** The task section of the last status update the developer declined. */
  private declinedSync: string | undefined;
  private readonly tools: ToolRegistry = createToolRegistry();
  readonly changeIO: ChangeIO = new VsCodeChangeIO(workspaceRoot);

  constructor(private readonly services: Services) {
    this.sessions = new SessionStore(services.context.workspaceState);
    const latest = this.sessions.list()[0];
    this.session = (latest && this.sessions.get(latest.id)) || this.sessions.create();
    services.workspace.onEditorChanged = (editor) => this.post({ type: 'editorContext', editor });
    services.context.subscriptions.push(this.review);
    this.storeReady = this.openStore().catch((err) => {
      services.logger.error('Could not open the project database; tasks will not be saved', err);
    });
  }

  // ───────────────────────── project store ─────────────────────────

  /**
   * The database lives in `.byteagent/` once the developer has set up
   * project knowledge there. Until then it stays in VS Code's own storage
   * for this workspace, so nothing is written into the project unasked.
   */
  private databasePath(): string | undefined {
    const root = workspaceRoot();
    if (!root) return undefined;
    if (existsSync(path.join(root, KNOWLEDGE_DIR))) return path.join(root, KNOWLEDGE_DIR, 'agent.db');
    const storage = this.services.context.storageUri?.fsPath;
    return storage ? path.join(storage, 'agent.db') : undefined;
  }

  private async openStore(): Promise<void> {
    const dbPath = this.databasePath();
    if (!dbPath) return;
    const wasmPath = path.join(this.services.context.extensionUri.fsPath, 'dist', 'sql-wasm.wasm');
    this.store = await ProjectStore.open({ path: dbPath, wasmPath, logger: this.services.logger });
    this.tasks = this.store;
    if (this.store.recoveredFrom) {
      this.post({ type: 'toast', level: 'warn', message: 'The saved task database could not be read. It was kept as a backup file and a new one was started.' });
    }
    this.services.logger.info(`Project database: ${dbPath}`);
  }

  /** Resolves when the project database is ready (or known to be unavailable). */
  ready(): Promise<void> {
    return this.storeReady;
  }

  get projectStore(): ProjectStore | undefined {
    return this.store;
  }

  /** Saves pending data and closes the database. */
  async dispose(): Promise<void> {
    this.stop();
    await this.runPromise.catch(() => undefined);
    await this.storeReady;
    await this.store?.dispose();
    this.store = undefined;
  }

  /** Closes and reopens the database, as a restart of the editor would. Used by tests. */
  async reloadStore(): Promise<void> {
    await this.storeReady;
    await this.store?.dispose();
    this.store = undefined;
    this.tasks = new MemoryTaskTracker();
    this.storeReady = this.openStore();
    await this.storeReady;
  }

  // ───────────────────────── webview plumbing ─────────────────────────

  attach(poster: Poster): void {
    this.poster = poster;
  }

  detach(): void {
    this.poster = undefined;
  }

  post(message: HostMessage): void {
    this.poster?.(message);
  }

  /** Switches the webview to a view, now or as soon as it is ready. */
  showView(view: ViewName): void {
    if (this.poster) this.post({ type: 'showView', view });
    else this.pendingView = view;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get currentSession(): Session {
    return this.session;
  }

  /** Waits until no run is in progress. */
  whenIdle(): Promise<void> {
    return this.runPromise;
  }

  async buildState(): Promise<AppState> {
    await this.storeReady;
    const { settings, problems } = this.services.settings();
    const root = workspaceRoot();
    const profiles = await this.services.profiles.list();
    return {
      ready: true,
      hasWorkspace: Boolean(workspaceRoot()),
      workspaceName: workspaceName(),
      profiles,
      activeProfileId: settings.activeProvider,
      presets: PROVIDER_PRESETS,
      settingsProblems: problems,
      defaultMode: settings.defaultMode,
      sessions: this.sessions.list(),
      sessionId: this.session.id,
      items: this.session.items,
      busy: this.busy,
      usage: this.session.usage,
      tasks: this.tasks
        .list()
        .filter(isOpen)
        .slice(0, 20)
        .map((task: TaskState) => ({
          id: task.id,
          title: task.title,
          mode: task.mode,
          status: task.status,
          updatedAt: task.updatedAt,
          stepsDone: taskProgress(task).done,
          stepsTotal: taskProgress(task).total,
        })),
      projectInitialized: Boolean(root && existsSync(path.join(root, ...CONTEXT_FILE.split('/')))),
      editor: this.services.workspace.editorContext(),
    };
  }

  async pushState(): Promise<void> {
    if (!this.poster) return;
    this.flushText();
    this.post({ type: 'state', state: await this.buildState() });
  }

  // ───────────────────────── AgentEvents ─────────────────────────

  add(item: ChatItem): void {
    this.flushText();
    this.session.items.push(item);
    this.post({ type: 'itemAdded', sessionId: this.session.id, item });
  }

  update(id: string, patch: ChatItemPatch): void {
    this.flushText();
    const index = this.session.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    this.session.items[index] = { ...this.session.items[index], ...patch } as ChatItem;
    this.post({ type: 'itemUpdated', sessionId: this.session.id, id, patch });
  }

  appendText(id: string, delta: string): void {
    const item = this.session.items.find((i) => i.id === id);
    if (!item || item.kind !== 'assistant') return;
    item.text += delta;
    // Many tiny deltas are merged into one message per frame.
    this.pendingText.set(id, (this.pendingText.get(id) ?? '') + delta);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushText(), DELTA_FLUSH_MS);
  }

  usage(usage: UsageView): void {
    this.session.usage = usage;
    this.post({ type: 'usage', sessionId: this.session.id, usage });
  }

  private flushText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const [id, delta] of this.pendingText) {
      this.post({ type: 'textDelta', sessionId: this.session.id, id, delta });
    }
    this.pendingText.clear();
  }

  // ───────────────────────── AgentHost ─────────────────────────

  /**
   * Waits for the webview to answer a request. Stopping the run answers
   * with `fallback`, which is always the safe choice (do nothing).
   */
  private ask<T>(requestId: string, signal: AbortSignal, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      if (signal.aborted) {
        resolve(fallback);
        return;
      }
      const finish = (answer: unknown): void => {
        this.pending.delete(requestId);
        signal.removeEventListener('abort', onAbort);
        resolve(answer as T);
      };
      const onAbort = (): void => finish(fallback);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, finish);
    });
  }

  /** Delivers the user's answer. Returns false when nothing was waiting for it. */
  private answer(requestId: string, value: unknown): boolean {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    resolve(value);
    return true;
  }

  /** Number of questions currently waiting for the user. Used by tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  confirmContext(requestId: string, signal: AbortSignal): Promise<boolean> {
    return this.ask<boolean>(requestId, signal, false);
  }

  approveCommand(request: CommandRequest, signal: AbortSignal): Promise<CommandDecision> {
    // Stopping the run answers "deny".
    return this.ask<CommandDecision>(request.requestId, signal, 'deny');
  }

  isCommandRemembered(command: string): boolean {
    return this.rememberedCommands().includes(command);
  }

  async rememberCommand(command: string): Promise<void> {
    const list = this.rememberedCommands();
    if (list.includes(command)) return;
    await this.services.context.workspaceState.update(REMEMBERED_COMMANDS_KEY, [...list, command].slice(-200));
    this.services.logger.info(`Command will be allowed without asking in this workspace: ${command}`);
  }

  /** Commands the user chose to always allow in this workspace. */
  rememberedCommands(): string[] {
    const stored = this.services.context.workspaceState.get<unknown>(REMEMBERED_COMMANDS_KEY);
    return Array.isArray(stored) ? stored.filter((c): c is string => typeof c === 'string') : [];
  }

  async forgetCommands(): Promise<void> {
    await this.services.context.workspaceState.update(REMEMBERED_COMMANDS_KEY, undefined);
  }

  get commandTimeoutMs(): number {
    return this.services.settings().settings.commandTimeoutSeconds * 1000;
  }

  async getDiagnostics(paths: string[]): Promise<DiagnosticSummary | null> {
    const root = workspaceRoot();
    if (!root || paths.length === 0) return null;
    // Language services need a moment to look at files that just changed.
    await new Promise((resolve) => setTimeout(resolve, DIAGNOSTICS_SETTLE_MS));
    let errors = 0;
    let warnings = 0;
    const files: string[] = [];
    for (const relative of paths) {
      const uri = vscode.Uri.file(path.join(root, ...relative.split('/')));
      const found = vscode.languages.getDiagnostics(uri);
      const fileErrors = found.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
      errors += fileErrors;
      warnings += found.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
      if (fileErrors > 0) files.push(relative);
    }
    return { errors, warnings, files };
  }

  reviewChanges(changeSet: ChangeSet, signal: AbortSignal): Promise<ReviewDecision> {
    this.review.remember(changeSet);
    // Stopping the run answers with no accepted files.
    return this.ask<ReviewDecision>(changeSet.id, signal, { decisions: {} });
  }

  // ───────────────────────── messages ─────────────────────────

  async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      await this.dispatch(message);
    } catch (err) {
      this.services.logger.error(`Failed to handle "${message.type}"`, err);
      this.post({ type: 'toast', level: 'error', message: this.services.redactor.redact(describeError(err)) });
    }
  }

  private async dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        await this.pushState();
        if (this.pendingView) {
          this.post({ type: 'showView', view: this.pendingView });
          this.pendingView = undefined;
        }
        return;
      }
      case 'sendPrompt':
        this.startRun({ text: message.text, mode: message.mode, attachments: message.attachments });
        return;
      case 'stop':
        this.stop();
        return;
      case 'retry':
        this.retry();
        return;
      case 'newChat':
        await this.newChat();
        return;
      case 'openSession':
        await this.openSession(message.id);
        return;
      case 'deleteSession':
        await this.deleteSession(message.id);
        return;
      case 'saveProfile': {
        const result = await this.services.profiles.save(message.draft, message.apiKey, message.makeActive);
        this.post({ type: 'profileSaved', requestId: message.requestId, ...result });
        if (result.ok) {
          this.services.logger.info(`Saved provider profile "${result.profileId}"`);
          await this.pushState();
        }
        return;
      }
      case 'deleteProfile': {
        await this.services.profiles.remove(message.id);
        this.services.logger.info(`Deleted provider profile "${message.id}"`);
        await this.pushState();
        return;
      }
      case 'setActiveProfile': {
        await this.services.profiles.setActive(message.id);
        await this.pushState();
        return;
      }
      case 'setModel': {
        const active = this.services.settings().settings.activeProvider;
        if (active) await this.services.profiles.setModel(active, message.model);
        await this.pushState();
        return;
      }
      case 'setMode': {
        await writeDefaultMode(message.mode);
        await this.pushState();
        return;
      }
      case 'testConnection': {
        const result = await this.testDraft(message.draft, message.apiKey);
        this.post({ type: 'connectionResult', requestId: message.requestId, ...result });
        return;
      }
      case 'listModels': {
        const result = await this.listDraftModels(message.draft, message.apiKey);
        this.post({ type: 'models', requestId: message.requestId, ...result });
        return;
      }
      case 'contextDecision':
        this.answer(message.requestId, message.send);
        return;
      case 'reviewDecision': {
        // Only an explicit "accept" counts; anything else is a rejection.
        const decisions: Record<string, 'accept' | 'reject'> = {};
        for (const [id, value] of Object.entries(message.decisions ?? {})) decisions[id] = value === 'accept' ? 'accept' : 'reject';
        const feedback = typeof message.feedback === 'string' && message.feedback.trim() ? message.feedback.trim().slice(0, 2000) : undefined;
        if (feedback) for (const id of Object.keys(decisions)) decisions[id] = 'reject';
        if (!this.answer(message.changeSetId, { decisions, feedback } satisfies ReviewDecision)) {
          this.post({ type: 'toast', level: 'warn', message: 'That proposal is no longer waiting for review.' });
        }
        return;
      }
      case 'commandDecision': {
        const decision: CommandDecision = message.decision === 'once' || message.decision === 'always' ? message.decision : 'deny';
        if (!this.answer(message.requestId, decision)) {
          this.post({ type: 'toast', level: 'warn', message: 'That command is no longer waiting for approval.' });
        }
        return;
      }
      case 'openDiff': {
        if (!(await this.review.openDiff(message.changeSetId, message.changeId))) {
          this.post({ type: 'toast', level: 'info', message: 'The diff for that change is no longer available.' });
        }
        return;
      }
      case 'searchFiles': {
        const index = this.services.workspace.index;
        let files: string[] = [];
        if (index) {
          await index.ensureFresh();
          files = findFiles(index, message.query, 12);
        }
        this.post({ type: 'fileSuggestions', requestId: message.requestId, files });
        return;
      }
      case 'resumeTask':
        await this.resumeTask(message.taskId);
        return;
      case 'initProject':
        // The command asks the questions (requirements, optional files) first.
        await vscode.commands.executeCommand('byteagent.initProject');
        return;
      case 'openFile':
        await this.openFile(message.path, message.line);
        return;
      case 'openVsCodeSettings': {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:byteagent.byteagent');
        return;
      }
      case 'openExternal': {
        const uri = vscode.Uri.parse(message.url, true);
        if (uri.scheme === 'https' || uri.scheme === 'http') await vscode.env.openExternal(uri);
        return;
      }
      case 'copy': {
        await vscode.env.clipboard.writeText(message.text);
        return;
      }
      default:
        // Every known message type is handled above; anything else is ignored.
        this.services.logger.debug(`Unhandled webview message "${(message as { type?: string }).type}"`);
    }
  }

  // ───────────────────────── runs ─────────────────────────

  /** Starts a run unless one is active. Returns false when it was ignored. */
  startRun(input: PromptInput): boolean {
    const text = input.text.trim();
    if (!text || this.busy) return false;
    return this.begin(() => this.run({ ...input, text }));
  }

  /** Marks the controller busy for the duration of one piece of work. */
  private begin(work: () => Promise<void>): boolean {
    if (this.busy) return false;
    this.busy = true;
    this.runPromise = work()
      .catch((err) => {
        this.services.logger.error('Unexpected failure', err);
        this.add({ kind: 'error', id: newId('e'), message: this.services.redactor.redact(describeError(err)), code: 'internal' });
      })
      .finally(() => {
        this.busy = false;
        this.abort = undefined;
        this.flushText();
        this.post({ type: 'busy', sessionId: this.session.id, busy: false });
      });
    return true;
  }

  stop(): void {
    this.abort?.abort();
  }

  retry(): void {
    if (this.busy || !this.lastPrompt) return;
    // Remove the failed attempt so the transcript shows one question, not two.
    const items = this.session.items;
    while (items.length > 0 && items[items.length - 1]?.kind !== 'user') items.pop();
    if (items[items.length - 1]?.kind === 'user') items.pop();
    void this.pushState();
    this.startRun(this.lastPrompt);
  }

  private async run(input: PromptInput): Promise<void> {
    const session = this.session;
    this.lastPrompt = input.resumeTaskId ? undefined : input;
    this.post({ type: 'busy', sessionId: session.id, busy: true });
    await this.storeReady;
    const resumeTask = input.resumeTaskId ? this.tasks.get(input.resumeTaskId) : undefined;
    if (input.resumeTaskId && (!resumeTask || !isOpen(resumeTask))) {
      this.add({ kind: 'error', id: newId('e'), message: 'That task is finished or no longer exists.', code: 'not_found' });
      return;
    }
    if (session.items.length === 0) session.title = resumeTask ? `Resume: ${resumeTask.title}` : titleFromPrompt(input.text);

    const provider = await this.activeProvider();
    if (!provider) {
      this.add({ kind: 'user', id: newId('u'), text: input.text, attachments: input.attachments, mode: input.mode });
      this.add({
        kind: 'error',
        id: newId('e'),
        message: 'No provider is set up yet. Add one to start chatting.',
        code: 'no_provider',
        openSettings: true,
      });
      return;
    }

    this.abort = new AbortController();
    const { settings } = this.services.settings();
    const workspace = this.services.workspace;
    const index = workspace.index;
    const runtime = new AgentRuntime({
      provider,
      events: this,
      host: this,
      logger: this.services.logger,
      workspace: index ? { index, ripgrepPath: workspace.ripgrepPath } : undefined,
      tools: this.tools,
      tasks: this.tasks,
      limits: { defaultContextWindow: settings.defaultContextWindow, confirmBeforeSend: settings.confirmBeforeSend },
      redact: (text) => this.services.redactor.redact(text),
    });
    try {
      const result = await runtime.run(
        {
          prompt: input.text,
          attachments: input.attachments,
          mode: input.mode,
          history: session.turns,
          workspaceName: workspaceName(),
          activeFile: workspace.editorContext().activeFile,
          openFiles: workspace.openFiles(),
          projectFacts: await workspace.projectFacts(),
          projectRules: [await workspace.projectRules(), await workspace.projectKnowledge()].filter(Boolean).join('\n\n'),
          sessionId: session.id,
          resumeTask,
        },
        this.abort.signal,
      );
      if (result.taskId) session.taskId = result.taskId;
      this.store?.recordRun({
        sessionId: session.id,
        taskId: result.taskId,
        record: result.record,
        status: result.status,
        mode: result.mode,
        providerId: provider.id,
        model: provider.model,
      });
      if (result.taskId && !this.abort.signal.aborted) await this.proposeStatusSync(this.abort.signal);
      if (result.turn) {
        session.turns.push(result.turn);
        if (session.turns.length > MAX_TURNS) session.turns.splice(0, session.turns.length - MAX_TURNS);
      }
    } catch (err) {
      this.services.logger.error('Unexpected failure in run', err);
      this.add({ kind: 'error', id: newId('e'), message: this.services.redactor.redact(describeError(err)), code: 'internal', canRetry: true });
    } finally {
      this.flushText();
      await this.sessions.save(session);
      await this.pushState();
    }
  }

  // ───────────────────────── project knowledge ─────────────────────────

  /** Shows a set of file changes for review and applies what is accepted. */
  private async reviewOperations(
    changes: Array<{ path: string; action: 'write'; content: string }>,
    summary: string,
    signal: AbortSignal,
  ): Promise<RunRecord | undefined> {
    const index = this.services.workspace.index;
    if (!index) return undefined;
    const record = newRunRecord();
    const context: ToolContext = {
      index,
      signal,
      host: this,
      events: this,
      record,
      logger: this.services.logger,
      redact: (text) => this.services.redactor.redact(text),
    };
    await proposeChangesTool.execute({ summary, changes }, context);
    return record;
  }

  /**
   * Offers an update of the generated task section in the status document.
   * Only that section changes, and only after the usual review.
   */
  private async proposeStatusSync(signal: AbortSignal): Promise<void> {
    const index = this.services.workspace.index;
    if (!index || !this.store) return;
    let current: string;
    try {
      current = (await index.readText(STATUS_FILE)).text;
    } catch {
      return; // no status document: nothing to keep in step
    }
    const section = renderTaskSection(this.store.list(), this.store.verifications({ limit: 500 }));
    // An update the developer declined is not offered again until the tasks change.
    if (section === this.declinedSync) return;
    const next = syncStatusDocument(current, section);
    if (!next) return;
    this.add({ kind: 'notice', id: newId('n'), level: 'info', text: 'The task list in the project status document is out of date. Review the update below.' });
    const record = await this.reviewOperations([{ path: STATUS_FILE, action: 'write', content: next }], 'Update the tracked tasks section from recorded task state', signal);
    this.declinedSync = record && record.applied.length > 0 ? undefined : section;
  }

  /**
   * Scans the project and proposes the knowledge files. Nothing is written
   * without review, and existing documents are never replaced.
   */
  async initProject(options: InitProjectOptions = {}): Promise<boolean> {
    return this.begin(async () => {
      const session = this.session;
      this.post({ type: 'busy', sessionId: session.id, busy: true });
      this.post({ type: 'showView', view: 'chat' });
      await this.storeReady;
      this.abort = new AbortController();
      const signal = this.abort.signal;
      if (session.items.length === 0) session.title = 'Set up project knowledge';
      try {
        this.add({ kind: 'user', id: newId('u'), text: 'Set up project knowledge', attachments: [], mode: 'auto' });
        const index = this.services.workspace.index;
        if (!index) {
          this.add({ kind: 'error', id: newId('e'), message: 'Open a folder first. Project knowledge is stored with the project.', code: 'no_workspace' });
          return;
        }
        const plan = await planOnboarding(index, { name: workspaceName(), requirements: options.requirements, includeAgentsFile: options.includeAgentsFile });
        this.add({ kind: 'assistant', id: newId('a'), text: describeBaseline(plan), streaming: false });
        if (plan.operations.length === 0) return;

        const record = await this.reviewOperations(
          plan.operations.flatMap((op) => (op.type === 'write' ? [{ path: op.path, action: 'write' as const, content: op.content }] : [])),
          plan.baseline.kind === 'new' ? 'Create project knowledge files for a new project' : 'Create project knowledge files from the scan',
          signal,
        );
        if (!record) return;
        const outcome = buildOutcome(record, null);
        if (outcome) this.add({ kind: 'outcome', id: newId('o'), outcome: { ...outcome, notes: [...outcome.notes, 'Setting up project knowledge runs no checks.'] } });

        // Once the folder exists with the developer's approval, the database moves into it.
        const root = workspaceRoot();
        if (root && this.store && record.applied.includes(IGNORE_FILE)) {
          await this.store.relocate(path.join(root, KNOWLEDGE_DIR, 'agent.db'));
          this.services.logger.info(`Project database moved to ${this.store.path}`);
        }
        if (this.store && record.applied.length > 0) {
          await index.refresh();
          this.store.saveFiles(index.files().map((f) => ({ path: f.path, size: f.size, mtimeMs: f.mtimeMs, ext: f.ext })));
          this.store.setMeta('onboarded_at', String(Date.now()));
          this.store.recordEvent({ sessionId: session.id, type: 'onboarding', data: { created: record.applied, kept: plan.kept, kind: plan.baseline.kind } });
        }
      } finally {
        this.flushText();
        await this.sessions.save(session);
        await this.pushState();
      }
    });
  }

  /** Continues a saved task in a fresh conversation, with whichever provider is active now. */
  async resumeTask(taskId: string): Promise<boolean> {
    await this.storeReady;
    const task = this.tasks.get(taskId);
    if (!task || !isOpen(task)) {
      this.post({ type: 'toast', level: 'warn', message: 'That task is finished or no longer exists.' });
      await this.pushState();
      return false;
    }
    if (this.busy) this.stop();
    await this.runPromise;
    if (this.session.items.length > 0) this.session = this.sessions.create();
    await this.pushState();
    this.post({ type: 'showView', view: 'chat' });
    return this.startRun({ text: 'Continue this task.', mode: task.mode, attachments: [], resumeTaskId: taskId });
  }

  // ───────────────────────── sessions ─────────────────────────

  async newChat(): Promise<void> {
    if (this.busy) this.stop();
    await this.runPromise;
    if (this.session.items.length > 0) this.session = this.sessions.create();
    this.lastPrompt = undefined;
    await this.pushState();
    this.post({ type: 'showView', view: 'chat' });
    this.post({ type: 'focusInput' });
  }

  async openSession(id: string): Promise<void> {
    if (id === this.session.id) {
      this.post({ type: 'showView', view: 'chat' });
      return;
    }
    if (this.busy) this.stop();
    await this.runPromise;
    const loaded = this.sessions.get(id);
    if (!loaded) {
      this.post({ type: 'toast', level: 'warn', message: 'That conversation is no longer available.' });
      await this.pushState();
      return;
    }
    this.session = loaded;
    this.lastPrompt = undefined;
    await this.pushState();
    this.post({ type: 'showView', view: 'chat' });
  }

  async deleteSession(id: string): Promise<void> {
    if (id === this.session.id) {
      if (this.busy) this.stop();
      await this.runPromise;
      this.session = this.sessions.create();
    }
    await this.sessions.delete(id);
    await this.pushState();
  }

  // ───────────────────────── providers ─────────────────────────

  /** The provider for the active profile, reused while its configuration is unchanged. */
  async activeProvider(): Promise<Provider | undefined> {
    const { settings } = this.services.settings();
    const profile = findActiveProfile(settings);
    if (!profile) return undefined;
    const apiKey = await this.services.secrets.getApiKey(profile.id);
    const signature = sha256(JSON.stringify(profile) + (apiKey ?? ''));
    if (this.providerCache?.signature === signature) return this.providerCache.provider;
    const provider = this.buildProvider(profile, apiKey);
    this.providerCache = { signature, provider };
    return provider;
  }

  private buildProvider(profile: ProviderProfile, apiKey: string | undefined): Provider {
    this.services.redactor.addSecret(apiKey);
    return createProvider(profile, { apiKey, redact: (text) => this.services.redactor.redact(text) });
  }

  async testDraft(draft: ProfileDraft, typedKey: string | null | undefined) {
    const { result } = this.services.profiles.check(draft);
    if (!result.ok || !result.profile) {
      return { ok: false, message: 'Fix the highlighted fields first.', errors: result.errors };
    }
    const apiKey = await this.services.profiles.resolveKey(draft, typedKey);
    const test = await this.buildProvider(result.profile, apiKey).testConnection();
    this.services.logger.info(`Connection test for "${result.profile.name}": ${test.ok ? 'ok' : test.message}`);
    return { ok: test.ok, message: test.message, latencyMs: test.latencyMs };
  }

  async listDraftModels(draft: ProfileDraft, typedKey: string | null | undefined): Promise<{ models: string[]; error?: string }> {
    const { result } = this.services.profiles.check({ ...draft, model: draft.model || 'placeholder' });
    if (!result.ok || !result.profile) {
      const first = result.errors.find((e) => e.field === 'baseUrl') ?? result.errors[0];
      return { models: [], error: first?.message ?? 'Check the base URL first.' };
    }
    try {
      const apiKey = await this.services.profiles.resolveKey(draft, typedKey);
      const models = await this.buildProvider(result.profile, apiKey).listModels();
      return { models: models.map((m) => m.id) };
    } catch (err) {
      return { models: [], error: this.services.redactor.redact(describeError(err)) };
    }
  }

  // ───────────────────────── editor ─────────────────────────

  /** Attaches the editor's current selection (or file) to the next message. */
  addSelectionToChat(): boolean {
    const editor = this.services.workspace.editorContext();
    const attachment: Attachment | undefined = editor.selection
      ? { ...editor.selection, source: 'selection' }
      : editor.activeFile
        ? { path: editor.activeFile, source: 'mention' }
        : undefined;
    if (!attachment) return false;
    this.post({ type: 'addAttachment', attachment });
    return true;
  }

  private async openFile(relativePath: string, line?: number): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    const target = path.resolve(root, relativePath);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
      if (line && line > 0) {
        const position = new vscode.Position(Math.min(line - 1, document.lineCount - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      this.post({ type: 'toast', level: 'warn', message: `Could not open ${relativePath}.` });
    }
  }
}
