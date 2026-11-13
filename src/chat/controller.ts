import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentEvents, AgentHost, CommandDecision, CommandRequest, DiagnosticSummary } from '../agent/host';
import type { ChangeIO, ChangeSet, ReviewDecision } from '../changes/types';
import { ChangeReviewService } from '../changes/vscodeReview';
import { AgentRuntime } from '../agent/runtime';
import { isOpen, MemoryTaskTracker, taskProgress, type TaskState, type TaskTracker } from '../agent/taskState';
import { findActiveProfile, PROVIDER_PRESETS, type ProviderProfile } from '../config/settings';
import { findFiles } from '../context/search';
import { writeDefaultMode } from '../config/vscodeSettings';
import { createProvider } from '../providers/factory';
import type { Provider } from '../providers/types';
import { describeError } from '../shared/errors';
import { createToolRegistry, type ToolRegistry } from '../tools';
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
  private readonly tools: ToolRegistry = createToolRegistry();
  readonly changeIO: ChangeIO = new VsCodeChangeIO(workspaceRoot);

  constructor(private readonly services: Services) {
    this.sessions = new SessionStore(services.context.workspaceState);
    const latest = this.sessions.list()[0];
    this.session = (latest && this.sessions.get(latest.id)) || this.sessions.create();
    services.workspace.onEditorChanged = (editor) => this.post({ type: 'editorContext', editor });
    services.context.subscriptions.push(this.review);
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
    const { settings, problems } = this.services.settings();
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
      projectInitialized: false,
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
        this.services.logger.debug(`Unhandled webview message "${message.type}"`);
    }
  }

  // ───────────────────────── runs ─────────────────────────

  /** Starts a run unless one is active. Returns false when it was ignored. */
  startRun(input: PromptInput): boolean {
    const text = input.text.trim();
    if (!text || this.busy) return false;
    this.busy = true;
    this.runPromise = this.run({ ...input, text }).finally(() => {
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
    this.lastPrompt = input;
    this.post({ type: 'busy', sessionId: session.id, busy: true });
    if (session.items.length === 0) session.title = titleFromPrompt(input.text);

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
          projectRules: await workspace.projectRules(),
          sessionId: session.id,
        },
        this.abort.signal,
      );
      if (result.taskId) session.taskId = result.taskId;
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
