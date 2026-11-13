import { newId } from '../shared/hash';
import type { ExecutionMode } from '../shared/protocol';

export type TaskStatus = 'planning' | 'in_progress' | 'paused' | 'done' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';

export interface TaskStep {
  id: string;
  title: string;
  status: StepStatus;
}

/**
 * A tracked piece of work. Everything needed to continue it lives here and
 * in the workspace, never in a provider's conversation history.
 */
export interface TaskState {
  id: string;
  title: string;
  /** The original request, word for word. */
  goal: string;
  mode: ExecutionMode;
  status: TaskStatus;
  criteria: string[];
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  /** Files this task changed, with the hash each had right after the change. */
  files: Record<string, string>;
  /** Factual notes from earlier runs: what was applied, which commands ran. */
  notes: string[];
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  planning: ['in_progress', 'paused', 'done', 'failed', 'cancelled'],
  in_progress: ['paused', 'done', 'failed', 'cancelled'],
  paused: ['in_progress', 'planning', 'done', 'cancelled'],
  failed: ['in_progress', 'planning', 'cancelled'],
  done: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Moves a task to a new status, or throws when the move is not allowed. */
export function transition(task: TaskState, to: TaskStatus, now = Date.now()): TaskState {
  if (!canTransition(task.status, to)) throw new Error(`A task cannot go from "${task.status}" to "${to}".`);
  return { ...task, status: to, updatedAt: now };
}

export function isOpen(task: TaskState): boolean {
  return task.status !== 'done' && task.status !== 'cancelled';
}

export function newTask(input: { goal: string; mode: ExecutionMode; sessionId?: string }, now = Date.now()): TaskState {
  const firstLine = input.goal.trim().split('\n')[0]?.trim() ?? '';
  return {
    id: newId('task'),
    title: firstLine.length > 70 ? `${firstLine.slice(0, 69).trimEnd()}…` : firstLine || 'Task',
    goal: input.goal,
    mode: input.mode,
    status: 'planning',
    criteria: [],
    steps: [],
    createdAt: now,
    updatedAt: now,
    sessionId: input.sessionId,
    files: {},
    notes: [],
  };
}

export interface PlanUpdate {
  goal?: string;
  criteria?: string[];
  steps: Array<{ id?: string; title: string; status?: StepStatus }>;
}

export const MAX_PLAN_STEPS = 30;
const STEP_STATUSES: StepStatus[] = ['pending', 'in_progress', 'done', 'blocked', 'skipped'];

/**
 * Applies a plan written by the model. The plan is data from the model, so
 * it is validated and normalised: unique ids, known statuses, and at most
 * one step in progress.
 */
export function applyPlanUpdate(task: TaskState, update: PlanUpdate, now = Date.now()): { task: TaskState; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(update.steps) || update.steps.length === 0) return { task, problems: ['A plan needs at least one step.'] };
  if (update.steps.length > MAX_PLAN_STEPS) return { task, problems: [`A plan may have at most ${MAX_PLAN_STEPS} steps. Group smaller items together.`] };

  const steps: TaskStep[] = [];
  const seen = new Set<string>();
  let active = false;
  update.steps.forEach((raw, index) => {
    const title = typeof raw.title === 'string' ? raw.title.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    if (!title) {
      problems.push(`Step ${index + 1} has no title.`);
      return;
    }
    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 40) : String(index + 1);
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    let status: StepStatus = STEP_STATUSES.includes(raw.status as StepStatus) ? (raw.status as StepStatus) : 'pending';
    if (raw.status !== undefined && !STEP_STATUSES.includes(raw.status)) problems.push(`Step "${title}" had an unknown status and was set to pending.`);
    if (status === 'in_progress') {
      if (active) {
        status = 'pending';
        problems.push(`Only one step can be in progress. "${title}" was set to pending.`);
      }
      active = true;
    }
    steps.push({ id, title, status });
  });
  if (steps.length === 0) return { task, problems };

  const criteria = Array.isArray(update.criteria)
    ? update.criteria.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim().slice(0, 300)).slice(0, 20)
    : task.criteria;

  let next: TaskState = { ...task, steps, criteria, updatedAt: now };
  if (next.status === 'planning' || next.status === 'paused' || next.status === 'failed') next = transition(next, 'in_progress', now);
  return { task: next, problems };
}

export function taskProgress(task: TaskState): { done: number; total: number } {
  const counted = task.steps.filter((s) => s.status !== 'skipped');
  return { done: counted.filter((s) => s.status === 'done').length, total: counted.length };
}

/** The status a task should have when a run ends. */
export function statusAfterRun(task: TaskState, run: 'completed' | 'cancelled' | 'failed'): TaskStatus {
  if (!isOpen(task)) return task.status;
  const { done, total } = taskProgress(task);
  if (run === 'completed' && total > 0 && done === total) return 'done';
  // Anything unfinished can be picked up again later.
  return 'paused';
}

/** Where tasks are kept. In memory for now; a persistent store can replace it. */
export interface TaskTracker {
  save(task: TaskState): void;
  get(id: string): TaskState | undefined;
  list(): TaskState[];
}

export class MemoryTaskTracker implements TaskTracker {
  private readonly tasks = new Map<string, TaskState>();
  save(task: TaskState): void {
    this.tasks.set(task.id, { ...task, steps: task.steps.map((s) => ({ ...s })), files: { ...task.files }, notes: [...task.notes], criteria: [...task.criteria] });
  }
  get(id: string): TaskState | undefined {
    return this.tasks.get(id);
  }
  list(): TaskState[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
