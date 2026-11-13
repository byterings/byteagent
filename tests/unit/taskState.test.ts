import { describe, expect, it } from 'vitest';
import { resumeBrief } from '../../src/agent/runtime';
import {
  applyPlanUpdate,
  canTransition,
  isOpen,
  MemoryTaskTracker,
  newTask,
  statusAfterRun,
  taskProgress,
  transition,
  type TaskState,
} from '../../src/agent/taskState';

const base = (): TaskState => newTask({ goal: 'Add token authentication across the API\nwith login and refresh', mode: 'project', sessionId: 's1' }, 1000);

describe('task state machine', () => {
  it('creates a task in planning with a title from the first line', () => {
    const task = base();
    expect(task).toMatchObject({ status: 'planning', title: 'Add token authentication across the API', mode: 'project', steps: [], criteria: [], sessionId: 's1' });
    expect(newTask({ goal: 'x'.repeat(200), mode: 'project' }).title.length).toBe(70);
    expect(newTask({ goal: '  ', mode: 'project' }).title).toBe('Task');
  });

  it('allows only meaningful transitions', () => {
    expect(canTransition('planning', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'paused')).toBe(true);
    expect(canTransition('paused', 'in_progress')).toBe(true);
    expect(canTransition('failed', 'in_progress')).toBe(true);
    expect(canTransition('done', 'in_progress')).toBe(false);
    expect(canTransition('cancelled', 'in_progress')).toBe(false);
    expect(canTransition('done', 'done')).toBe(true);
    expect(() => transition({ ...base(), status: 'done' }, 'in_progress')).toThrow(/cannot go from "done" to "in_progress"/);
    expect(transition(base(), 'in_progress', 2000)).toMatchObject({ status: 'in_progress', updatedAt: 2000 });
    expect(isOpen({ ...base(), status: 'paused' })).toBe(true);
    expect(isOpen({ ...base(), status: 'done' })).toBe(false);
  });
});

describe('applyPlanUpdate', () => {
  it('records steps and criteria and starts the task', () => {
    const { task, problems } = applyPlanUpdate(base(), {
      criteria: ['POST /login returns tokens', '  ', 'Tests pass'],
      steps: [{ title: 'Inspect routes', status: 'done' }, { title: 'Add  token   service', status: 'in_progress' }, { title: 'Protect routes' }],
    });
    expect(problems).toEqual([]);
    expect(task.status).toBe('in_progress');
    expect(task.criteria).toEqual(['POST /login returns tokens', 'Tests pass']);
    expect(task.steps).toEqual([
      { id: '1', title: 'Inspect routes', status: 'done' },
      { id: '2', title: 'Add token service', status: 'in_progress' },
      { id: '3', title: 'Protect routes', status: 'pending' },
    ]);
    expect(taskProgress(task)).toEqual({ done: 1, total: 3 });
  });

  it('keeps criteria when a later update omits them', () => {
    const first = applyPlanUpdate(base(), { criteria: ['A'], steps: [{ title: 'one' }] }).task;
    const second = applyPlanUpdate(first, { steps: [{ title: 'one', status: 'done' }] }).task;
    expect(second.criteria).toEqual(['A']);
  });

  it('normalises invalid model output instead of trusting it', () => {
    const { task, problems } = applyPlanUpdate(base(), {
      steps: [
        { id: 'a', title: 'first', status: 'in_progress' },
        { id: 'a', title: 'second', status: 'in_progress' },
        { title: '   ' },
        { title: 'third', status: 'finished' as never },
      ],
    });
    expect(task.steps.map((s) => [s.id, s.status])).toEqual([['a', 'in_progress'], ['a-2', 'pending'], ['4', 'pending']]);
    expect(problems).toHaveLength(3);
  });

  it('refuses empty and oversized plans without changing the task', () => {
    const task = base();
    expect(applyPlanUpdate(task, { steps: [] })).toEqual({ task, problems: ['A plan needs at least one step.'] });
    expect(applyPlanUpdate(task, { steps: 'x' as never }).task).toBe(task);
    expect(applyPlanUpdate(task, { steps: Array.from({ length: 31 }, (_, i) => ({ title: `s${i}` })) }).task).toBe(task);
    expect(applyPlanUpdate(task, { steps: [{ title: '' }] }).task).toBe(task);
  });

  it('does not reopen a finished task', () => {
    const done: TaskState = { ...base(), status: 'done' };
    expect(applyPlanUpdate(done, { steps: [{ title: 'more' }] }).task.status).toBe('done');
  });
});

describe('statusAfterRun', () => {
  const withSteps = (statuses: string[]): TaskState => applyPlanUpdate(base(), { steps: statuses.map((s, i) => ({ title: `s${i}`, status: s as never })) }).task;

  it('is done only when every step is done and the run completed', () => {
    expect(statusAfterRun(withSteps(['done', 'done']), 'completed')).toBe('done');
    expect(statusAfterRun(withSteps(['done', 'skipped']), 'completed')).toBe('done');
    expect(statusAfterRun(withSteps(['done', 'pending']), 'completed')).toBe('paused');
    expect(statusAfterRun(withSteps(['done', 'done']), 'cancelled')).toBe('paused');
    expect(statusAfterRun(withSteps(['done', 'done']), 'failed')).toBe('paused');
    expect(statusAfterRun(base(), 'completed')).toBe('paused');
    expect(statusAfterRun({ ...base(), status: 'cancelled' }, 'completed')).toBe('cancelled');
  });
});

describe('MemoryTaskTracker', () => {
  it('stores copies and lists newest first', () => {
    const tracker = new MemoryTaskTracker();
    const a = base();
    tracker.save(a);
    a.steps.push({ id: 'x', title: 'mutated after save', status: 'pending' });
    expect(tracker.get(a.id)?.steps).toEqual([]);
    const b = { ...newTask({ goal: 'second', mode: 'project' }, 5000) };
    tracker.save(b);
    expect(tracker.list().map((t) => t.id)).toEqual([b.id, a.id]);
    expect(tracker.get('nope')).toBeUndefined();
  });
});

describe('resumeBrief', () => {
  it('describes the task from stored state only', () => {
    let task = applyPlanUpdate(base(), { criteria: ['Tests pass'], steps: [{ title: 'Add token service', status: 'done' }, { title: 'Protect routes', status: 'in_progress' }] }).task;
    task = { ...task, files: { 'src/auth/token.ts': 'h1' }, notes: ['Files changed (approved by the user): src/auth/token.ts\nCommand run: npm test → exit code 0'] };
    const brief = resumeBrief(task, ['src/auth/token.ts']);
    expect(brief).toContain('Original request:\nAdd token authentication across the API\nwith login and refresh');
    expect(brief).toContain('- Tests pass');
    expect(brief).toContain('- [done] (1) Add token service');
    expect(brief).toContain('- [in_progress] (2) Protect routes');
    expect(brief).toContain('- Command run: npm test → exit code 0');
    expect(brief).toContain('Files this task has changed so far: src/auth/token.ts');
    expect(brief).toContain('modified or removed by someone else since then: src/auth/token.ts');
    expect(brief).toContain('not from memory of an earlier conversation');
  });

  it('handles a task that has no plan yet', () => {
    const brief = resumeBrief(base(), []);
    expect(brief).toContain('No plan was recorded yet.');
    expect(brief).not.toContain('modified or removed');
  });
});
