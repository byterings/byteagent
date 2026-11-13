import { buildContext, computeContextBudget, type ContextPackage } from '../context/contextBuilder';
import type { WorkspaceIndex } from '../context/workspaceIndex';
import type { ChatMessage, FinishReason, Provider, ToolCall, ToolSpec } from '../providers/types';
import { describeError, isCancellation, ProviderError } from '../shared/errors';
import { ABSENT_HASH, newId } from '../shared/hash';
import type { Logger } from '../shared/logger';
import type { Attachment, ExecutionMode, ModeSetting } from '../shared/protocol';
import { estimateMessagesTokens, estimateTokens } from '../shared/tokens';
import type { ToolRegistry } from '../tools/registry';
import { newRunRecord, type PermissionClass, type PlanAccess, type RunRecord, type ToolContext } from '../tools/types';
import { checkEscalation, classifyTask } from './classifier';
import type { AgentEvents, AgentHost, DiagnosticSummary, Turn } from './host';
import { buildOutcome } from './outcome';
import { buildSystemPrompt } from './prompts';
import { applyPlanUpdate, canTransition, newTask, statusAfterRun, taskProgress, transition, type TaskState, type TaskTracker } from './taskState';
import { parseTextToolCalls, toolInstructions, toTextProtocol } from './textTools';

export interface RunRequest {
  prompt: string;
  attachments: Attachment[];
  mode: ModeSetting;
  history: Turn[];
  workspaceName?: string;
  activeFile?: string;
  openFiles?: string[];
  /** Detected stack summary for the system prompt. */
  projectFacts?: string;
  /** Developer-written rules for agents. */
  projectRules?: string;
  sessionId?: string;
  /** Continue this saved task instead of starting from the prompt alone. */
  resumeTask?: TaskState;
}

export interface RunResult {
  status: 'completed' | 'cancelled' | 'failed';
  assistantText: string;
  /** Present when the exchange should be remembered for later prompts. */
  turn?: Turn;
  errorCode?: string;
  /** What was recorded during the run. */
  record: RunRecord;
  /** The mode the run ended in, after any escalation. */
  mode: ExecutionMode;
  /** Set when the run created or continued a tracked task. */
  taskId?: string;
}

export interface WorkspaceAccess {
  index: WorkspaceIndex;
  ripgrepPath?: string;
}

export interface RuntimeLimits {
  /** Context window assumed when the provider does not state one. */
  defaultContextWindow: number;
  /** Ask the user before each request leaves the machine. */
  confirmBeforeSend: boolean;
}

export interface RuntimeDeps {
  provider: Provider;
  events: AgentEvents;
  host: AgentHost;
  logger: Logger;
  /** Absent when no folder is open: the agent then only chats. */
  workspace?: WorkspaceAccess;
  /** Tools the model may call. Used only together with a workspace. */
  tools?: ToolRegistry;
  limits: RuntimeLimits;
  redact?: (text: string) => string;
  /** Where tracked tasks are saved. */
  tasks?: TaskTracker;
}

/** How much earlier conversation is replayed to the model, newest first. */
const HISTORY_TOKEN_BUDGET = 6000;

/** Model round trips allowed in one run, per mode. */
export const STEP_LIMITS: Record<ExecutionMode, number> = { quick: 12, standard: 24, project: 48 };

const COMPACTED = '[Earlier tool output removed to save space. Run the tool again if you need it.]';

interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  /** Problems parsing text-protocol tool calls, to report back to the model. */
  parseErrors: string[];
}

/**
 * Runs one user request against the provider. This is the only place that
 * drives the model; everything it does is reported through AgentEvents.
 */
export class AgentRuntime {
  private useTextTools = false;
  private reportedUsage = false;
  private outputTokens = 0;
  /** Text already shown from a step that ended in an error or a stop. */
  private partialText = '';

  constructor(private readonly deps: RuntimeDeps) {}

  async run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
    const { provider, events, logger, workspace, tasks } = this.deps;
    const record = newRunRecord();
    const spoken: string[] = [];
    const redact = this.deps.redact ?? ((text: string) => text);

    events.add({
      kind: 'user',
      id: newId('u'),
      text: request.prompt,
      attachments: request.attachments,
      mode: request.mode,
    });

    // ── Decide how deep to go ───────────────────────────────────────────
    const resuming = request.resumeTask;
    const classification = classifyTask({ prompt: resuming ? resuming.goal : request.prompt, attachments: request.attachments, setting: resuming ? resuming.mode : request.mode });
    let mode: ExecutionMode = classification.mode;
    events.add({
      kind: 'classification',
      id: newId('m'),
      mode,
      auto: classification.source === 'heuristic',
      reasons: resuming ? ['Continuing a saved task'] : classification.reasons,
      confidence: classification.confidence,
    });
    // A mode the user picked is not changed behind their back.
    const mayEscalate = classification.source === 'heuristic' && !resuming;

    const registry = workspace ? this.deps.tools : undefined;
    const allowedFor = (m: ExecutionMode): ReadonlySet<PermissionClass> =>
      new Set<PermissionClass>(m === 'quick' ? ['read', 'propose', 'execute'] : ['read', 'propose', 'execute', 'plan']);
    let allowed = allowedFor(mode);
    let toolSpecs = registry ? registry.specs(allowed) : [];
    this.useTextTools = toolSpecs.length > 0 && provider.getCapabilities().toolCalling === 'none';

    const systemPrompt = (): string =>
      buildSystemPrompt({
        mode,
        workspaceName: request.workspaceName,
        toolNames: toolSpecs.map((t) => t.name),
        projectFacts: request.projectFacts,
        projectRules: request.projectRules,
      });
    const history = resuming ? [] : historyMessages(request.history, HISTORY_TOKEN_BUDGET);

    // ── Task tracking (Project mode) ────────────────────────────────────
    let task: TaskState | undefined = resuming ? { ...resuming } : undefined;
    let planItemId: string | undefined;
    const showPlan = (): void => {
      if (!task || task.steps.length === 0) return;
      const view = { taskId: task.id, goal: task.title, steps: task.steps.map((s) => ({ ...s })), criteria: [...task.criteria] };
      if (planItemId) events.update(planItemId, view);
      else {
        planItemId = newId('p');
        events.add({ kind: 'plan', id: planItemId, ...view });
      }
    };
    const startTask = (): void => {
      if (task || !registry) return;
      task = newTask({ goal: request.prompt, mode, sessionId: request.sessionId });
      tasks?.save(task);
    };
    if (mode === 'project') startTask();
    if (task && resuming) {
      if (task.status !== 'in_progress' && canTransition(task.status, 'in_progress')) task = transition(task, 'in_progress');
      tasks?.save(task);
      showPlan();
    }

    const plan: PlanAccess = {
      update: (update) => {
        // Standard mode may keep a plan too; it becomes a task when it does.
        if (!task) {
          task = newTask({ goal: request.prompt, mode, sessionId: request.sessionId });
        }
        const applied = applyPlanUpdate(task, update);
        const changed = applied.task !== task;
        if (changed) {
          task = applied.task;
          if (update.goal && update.goal.trim()) task = { ...task, title: update.goal.trim().slice(0, 70) };
          tasks?.save(task);
          showPlan();
        }
        const progress = taskProgress(task);
        return { ok: changed, problems: applied.problems, ...progress };
      },
    };

    const finish = async (status: RunResult['status'], errorCode?: string): Promise<RunResult> => {
      const assistantText = spoken.join('\n\n').trim();
      const notes = summarizeRecord(record);
      if (task) {
        if (notes) task = { ...task, notes: [...task.notes, notes].slice(-20) };
        const next = statusAfterRun(task, status);
        if (canTransition(task.status, next)) task = transition(task, next);
        tasks?.save(task);
        if (planItemId && task.status === 'paused' && taskProgress(task).total > 0) {
          const { done, total } = taskProgress(task);
          events.add({ kind: 'notice', id: newId('n'), level: 'info', text: `Task saved with ${done} of ${total} steps done. You can resume it from History.` });
        }
      }
      const remembered = assistantText || notes;
      return {
        status,
        assistantText,
        errorCode,
        record,
        mode,
        taskId: task?.id,
        turn: remembered
          ? { user: request.prompt, assistant: assistantText + (status === 'cancelled' ? '\n[stopped by the user]' : ''), notes: notes || undefined }
          : undefined,
      };
    };

    // ── Context ─────────────────────────────────────────────────────────
    let brief = '';
    if (resuming && workspace) {
      const changed = await changedSince(workspace.index, resuming.files);
      brief = resumeBrief(resuming, changed);
      if (changed.length > 0) {
        events.add({
          kind: 'notice',
          id: newId('n'),
          level: 'warn',
          text: `Changed since this task last touched ${changed.length === 1 ? 'it' : 'them'}: ${changed.join(', ')}. ByteAgent will read ${changed.length === 1 ? 'it' : 'them'} again.`,
        });
      }
    } else if (resuming) brief = resumeBrief(resuming, []);

    let context: ContextPackage | undefined | null;
    try {
      const basis = resuming ? `${resuming.goal}\n${resuming.steps.find((st) => st.status !== 'done' && st.status !== 'skipped')?.title ?? ''}` : request.prompt;
      const fixed = estimateTokens(systemPrompt()) + estimateMessagesTokens(history) + estimateTokens(request.prompt) + estimateTokens(brief) + estimateTokens(JSON.stringify(toolSpecs));
      context = await this.gatherContext({ ...request, prompt: basis }, mode, fixed, signal);
    } catch (err) {
      if (isCancellation(err)) {
        events.add({ kind: 'notice', id: newId('n'), level: 'info', text: 'Stopped.' });
        return finish('cancelled');
      }
      logger.warn('Context selection failed; continuing without project files', err);
    }
    if (context === null) {
      events.add({ kind: 'notice', id: newId('n'), level: 'info', text: 'Nothing was sent.' });
      return finish('cancelled');
    }

    const parts: string[] = [];
    if (context?.rendered) parts.push(context.rendered);
    if (brief) parts.push(brief);
    parts.push(parts.length > 0 ? `User request:\n${request.prompt}` : request.prompt);
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt() }, ...history, { role: 'user', content: parts.join('\n\n') }];

    const toolContext: ToolContext | undefined =
      registry && workspace
        ? { index: workspace.index, ripgrepPath: workspace.ripgrepPath, signal, host: this.deps.host, events, record, logger, redact, plan }
        : undefined;

    /** Records which files the task changed, with their current hash. */
    const syncTaskFiles = async (): Promise<void> => {
      if (!task || !workspace) return;
      let changed = false;
      for (const path of new Set(record.applied)) {
        const hash = await workspace.index.currentHash(path).catch(() => undefined);
        if (hash && task.files[path] !== hash) {
          task = { ...task, files: { ...task.files, [path]: hash }, updatedAt: Date.now() };
          changed = true;
        }
      }
      if (changed) tasks?.save(task);
    };

    let planReminderSent = false;
    try {
      for (let step = 1; ; step++) {
        this.fitMessages(messages);
        const result = await this.streamStep(messages, toolSpecs, signal);
        if (result.text.trim()) spoken.push(result.text.trim());

        if (result.finishReason === 'length') {
          events.add({ kind: 'notice', id: newId('n'), level: 'warn', text: 'The reply was cut off because it reached the output limit.' });
        } else if (result.finishReason === 'incomplete') {
          events.add({ kind: 'notice', id: newId('n'), level: 'warn', text: 'The connection ended before the reply was complete.' });
        }

        if (result.toolCalls.length === 0 && result.parseErrors.length === 0) {
          if (!result.text.trim() && spoken.length === 0) {
            events.add({ kind: 'notice', id: newId('n'), level: 'warn', text: 'The model returned an empty reply.' });
          }
          break;
        }
        if (!registry || !toolContext) break; // tools were not offered; ignore stray calls

        messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined });
        for (const call of result.toolCalls) {
          const outcome = await registry.invoke(call, toolContext, allowed);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: outcome.content });
        }
        if (result.parseErrors.length > 0) {
          messages.push({ role: 'user', content: `Problem with your tool call:\n- ${result.parseErrors.join('\n- ')}` });
        }
        await syncTaskFiles();

        // ── Escalate when the work has outgrown its mode ──────────────────
        if (mayEscalate) {
          const proposed = [...record.applied, ...record.rejected, ...record.stale, ...record.failed.map((f) => f.path)];
          const escalation = checkEscalation(mode, { filesProposed: proposed, steps: step, filesRead: record.filesRead.size });
          if (escalation) {
            const from = mode;
            mode = escalation.to;
            allowed = allowedFor(mode);
            toolSpecs = registry.specs(allowed);
            messages[0] = { role: 'system', content: systemPrompt() };
            events.add({ kind: 'classification', id: newId('m'), mode, auto: true, reasons: [escalation.reason], confidence: 1, escalatedFrom: from });
            if (mode === 'project') startTask();
            if (task) {
              task = { ...task, mode };
              tasks?.save(task);
            }
            messages.push({ role: 'user', content: escalationNote(mode, escalation.reason) });
            logger.info(`Escalated from ${from} to ${mode}: ${escalation.reason}`);
          }
        }

        if (mode === 'project' && !planReminderSent && step >= 3 && (!task || task.steps.length === 0)) {
          planReminderSent = true;
          messages.push({ role: 'user', content: '[ByteAgent] This is a Project task and no plan has been recorded yet. Call update_plan now with the goal, acceptance criteria and ordered steps, then continue.' });
        }

        if (step >= STEP_LIMITS[mode]) {
          events.add({
            kind: 'notice',
            id: newId('n'),
            level: 'warn',
            text: `Stopped after ${STEP_LIMITS[mode]} steps, the limit for ${mode[0]?.toUpperCase()}${mode.slice(1)} mode. Send a follow-up message to continue.`,
          });
          break;
        }
      }

      if (!this.reportedUsage) {
        events.usage({ inputTokens: estimateMessagesTokens(messages), outputTokens: this.outputTokens, estimated: true });
      }
      await this.reportOutcome(record);
      return finish('completed');
    } catch (err) {
      // What the user already saw stays part of the conversation.
      if (this.partialText.trim()) spoken.push(this.partialText.trim());
      this.partialText = '';
      await syncTaskFiles().catch(() => undefined);
      if (isCancellation(err)) {
        events.add({ kind: 'notice', id: newId('n'), level: 'info', text: 'Stopped.' });
        await this.reportOutcome(record);
        return finish('cancelled');
      }
      logger.error('Run failed', err);
      const code = err instanceof ProviderError ? err.code : 'internal';
      events.add({
        kind: 'error',
        id: newId('e'),
        message: redact(describeError(err)),
        code,
        // Retrying would repeat work that already changed files.
        canRetry: record.applied.length === 0 && record.commands.length === 0 && !resuming,
        openSettings: code === 'auth' || code === 'not_found' || code === 'network',
      });
      await this.reportOutcome(record);
      return finish('failed', code);
    }
  }

  /**
   * Shows what actually happened in this run. It is produced however the
   * run ended, because applied changes stay applied.
   */
  private async reportOutcome(record: RunRecord): Promise<void> {
    let diagnostics: DiagnosticSummary | null = null;
    const applied = [...new Set(record.applied)];
    if (applied.length > 0) {
      try {
        diagnostics = await this.deps.host.getDiagnostics(applied);
      } catch (err) {
        this.deps.logger.warn('Could not read editor diagnostics', err);
      }
    }
    const outcome = buildOutcome(record, diagnostics);
    if (outcome) this.deps.events.add({ kind: 'outcome', id: newId('o'), outcome });
  }

  /** One model round trip: streams text into the transcript and collects tool calls. */
  private async streamStep(messages: ChatMessage[], toolSpecs: ToolSpec[], signal: AbortSignal): Promise<StepResult> {
    const { provider, events, logger } = this.deps;

    for (;;) {
      let itemId: string | undefined;
      let text = '';
      const toolCalls: ToolCall[] = [];
      let finishReason: FinishReason = 'unknown';
      const textMode = this.useTextTools;

      const outgoing = textMode
        ? toTextProtocol(messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: `${m.content}\n\n${toolInstructions(toolSpecs)}` } : m)))
        : messages;

      try {
        for await (const event of provider.stream({ messages: outgoing, tools: textMode || toolSpecs.length === 0 ? undefined : toolSpecs }, signal)) {
          if (event.type === 'text') {
            if (!event.delta) continue;
            if (!itemId) {
              itemId = newId('a');
              events.add({ kind: 'assistant', id: itemId, text: '', streaming: true });
            }
            text += event.delta;
            events.appendText(itemId, event.delta);
          } else if (event.type === 'tool_call') {
            toolCalls.push(event.call);
          } else if (event.type === 'usage') {
            this.reportedUsage = true;
            events.usage({ ...event.usage, estimated: false });
          } else if (event.type === 'done') {
            finishReason = event.finishReason;
          }
        }
      } catch (err) {
        if (itemId) events.update(itemId, { streaming: false });
        this.partialText = text;
        // The endpoint has no native tool calling: switch to the text protocol and ask again.
        if (err instanceof ProviderError && err.code === 'tools_unsupported' && !this.useTextTools && toolSpecs.length > 0 && !text) {
          this.useTextTools = true;
          logger.info('Endpoint rejected native tools; switching to the text tool protocol');
          events.add({ kind: 'notice', id: newId('n'), level: 'info', text: 'This endpoint has no built-in tool calling, so ByteAgent is using its text-based fallback.' });
          continue;
        }
        throw err;
      }

      this.outputTokens += estimateTokens(text);
      let parseErrors: string[] = [];
      if (textMode && text) {
        const parsed = parseTextToolCalls(text, newId('call'));
        toolCalls.push(...parsed.calls);
        parseErrors = parsed.errors;
        if (itemId && parsed.cleaned !== text) events.update(itemId, { text: parsed.cleaned });
      }
      if (itemId) events.update(itemId, { streaming: false });
      return { text, toolCalls, finishReason, parseErrors };
    }
  }

  /**
   * Keeps the conversation inside the model's context window by removing
   * the oldest tool outputs first. The request and recent results stay.
   */
  private fitMessages(messages: ChatMessage[]): void {
    const capabilities = this.deps.provider.getCapabilities();
    const window = capabilities.contextWindow ?? this.deps.limits.defaultContextWindow;
    const reserved = capabilities.maxOutputTokens ?? Math.min(4096, Math.floor(window * 0.25));
    const limit = window - reserved - Math.ceil(window * 0.05);
    let total = estimateMessagesTokens(messages);
    if (total <= limit) return;
    // Keep the two most recent tool results intact.
    const toolIndexes = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    for (const i of toolIndexes.slice(0, Math.max(0, toolIndexes.length - 2))) {
      const message = messages[i] as ChatMessage;
      if (message.content === COMPACTED || message.content.length < 400) continue;
      total -= estimateTokens(message.content) - estimateTokens(COMPACTED);
      messages[i] = { ...message, content: COMPACTED };
      if (total <= limit) return;
    }
  }

  /**
   * Selects project files for the request and shows the selection. Returns
   * undefined when there is no workspace, and null when the user declined
   * to send.
   */
  private async gatherContext(
    request: RunRequest,
    mode: ExecutionMode,
    fixedTokens: number,
    signal: AbortSignal,
  ): Promise<ContextPackage | undefined | null> {
    const { provider, events, host, workspace, limits } = this.deps;
    if (!workspace) return undefined;

    const capabilities = provider.getCapabilities();
    const budgetTokens = computeContextBudget({
      contextWindow: capabilities.contextWindow ?? limits.defaultContextWindow,
      maxOutputTokens: capabilities.maxOutputTokens,
      fixedTokens,
      mode,
    });
    const pkg = await buildContext(workspace.index, {
      prompt: request.prompt,
      attachments: request.attachments,
      activeFile: request.activeFile,
      openFiles: request.openFiles,
      mode,
      budgetTokens,
      ripgrepPath: workspace.ripgrepPath,
      signal,
    });

    const itemId = newId('x');
    const requestId = newId('q');
    events.add({
      kind: 'context',
      id: itemId,
      files: pkg.files.map((f) => {
        const partial = f.startLine > 1 || f.endLine < f.totalLines;
        return {
          path: f.path,
          reason: f.reason,
          tokens: f.tokens,
          truncated: f.truncated || undefined,
          startLine: partial ? f.startLine : undefined,
          endLine: partial ? f.endLine : undefined,
        };
      }),
      omitted: pkg.omitted,
      totalTokens: pkg.totalTokens,
      budget: pkg.budget,
      confirm: limits.confirmBeforeSend ? { requestId, status: 'pending' } : undefined,
    });

    if (limits.confirmBeforeSend) {
      const send = await host.confirmContext(requestId, signal);
      events.update(itemId, { confirm: { requestId, status: send ? 'sent' : 'cancelled' } });
      if (!send) return null;
    }
    return pkg;
  }
}

function escalationNote(mode: ExecutionMode, reason: string): string {
  const label = `${mode[0]?.toUpperCase()}${mode.slice(1)}`;
  if (mode === 'project') {
    return `[ByteAgent] This task is larger than it first looked (${reason.toLowerCase()}). It is now a ${label} task. Call update_plan with the goal, acceptance criteria and ordered steps, including what is already done, then continue one step at a time and verify at milestones.`;
  }
  return `[ByteAgent] This task is larger than it first looked (${reason.toLowerCase()}). It is now a ${label} task. State a short plan, inspect the related files, and run a focused check after the changes are applied.`;
}

/** Files whose content no longer matches what the task recorded. */
export async function changedSince(index: WorkspaceIndex, files: Record<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const [path, hash] of Object.entries(files)) {
    let current: string;
    try {
      current = await index.currentHash(path);
    } catch {
      current = ABSENT_HASH;
    }
    if (current !== hash) changed.push(path);
  }
  return changed.sort();
}

/**
 * Everything a model needs to continue a saved task, built from stored
 * state. It does not depend on any earlier conversation, so a different
 * provider can pick the task up.
 */
export function resumeBrief(task: TaskState, changedFiles: string[]): string {
  const lines: string[] = ['You are continuing a saved task. This summary comes from recorded state, not from memory of an earlier conversation.', '', `Original request:\n${task.goal}`];
  if (task.criteria.length > 0) lines.push('', 'Acceptance criteria:', ...task.criteria.map((c) => `- ${c}`));
  if (task.steps.length > 0) {
    lines.push('', 'Plan and progress:', ...task.steps.map((s) => `- [${s.status}] (${s.id}) ${s.title}`));
  } else lines.push('', 'No plan was recorded yet.');
  if (task.notes.length > 0) lines.push('', 'Recorded results of earlier work:', ...task.notes.slice(-8).map((n) => n.split('\n').map((l) => `- ${l}`).join('\n')));
  const touched = Object.keys(task.files);
  if (touched.length > 0) lines.push('', `Files this task has changed so far: ${touched.join(', ')}`);
  if (changedFiles.length > 0) {
    lines.push('', `These files were modified or removed by someone else since then: ${changedFiles.join(', ')}. Read them again before building on them.`);
  }
  lines.push('', 'Check the current state of the files you need, then continue with the first step that is not done. Keep the plan up to date with update_plan.');
  return lines.join('\n');
}

/** A short factual record of a run, kept with the conversation history. */
export function summarizeRecord(record: RunRecord): string {
  const lines: string[] = [];
  if (record.applied.length > 0) lines.push(`Files changed (approved by the user): ${[...new Set(record.applied)].join(', ')}`);
  if (record.rejected.length > 0) lines.push(`Changes rejected by the user, not applied: ${[...new Set(record.rejected)].join(', ')}`);
  if (record.stale.length > 0) lines.push(`Not applied because the file changed first: ${[...new Set(record.stale)].join(', ')}`);
  for (const failure of record.failed) lines.push(`Failed to apply ${failure.path}: ${failure.error}`);
  for (const command of record.commands) {
    if (command.status === 'denied') lines.push(`Command not run (denied by the user): ${command.command}`);
    else lines.push(`Command run: ${command.command} → ${command.status === 'done' ? `exit code ${command.exitCode}` : command.status}`);
  }
  for (const feedback of record.feedback) lines.push(`User feedback on a proposal: ${feedback}`);
  return lines.join('\n');
}

/** Replays as many recent turns as fit in the budget, oldest first. */
export function historyMessages(history: Turn[], budget: number): ChatMessage[] {
  const picked: Turn[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i] as Turn;
    const cost = estimateTokens(turn.user) + estimateTokens(turn.assistant) + estimateTokens(turn.notes ?? '') + 12;
    if (used + cost > budget && picked.length > 0) break;
    if (cost > budget) break;
    picked.unshift(turn);
    used += cost;
  }
  return picked.flatMap((turn): ChatMessage[] => [
    { role: 'user', content: turn.user },
    { role: 'assistant', content: turn.notes ? `${turn.assistant}\n\n[Recorded actions]\n${turn.notes}`.trim() : turn.assistant },
  ]);
}
