import type { PlanUpdate } from '../../agent/taskState';
import type { ToolDefinition } from '../types';

export const updatePlanTool: ToolDefinition<PlanUpdate> = {
  name: 'update_plan',
  description: [
    'Record or update the plan for this task. The user sees it as a checklist, and it is saved so the work can continue later.',
    'Send the complete list of steps every time. Mark the step you are starting as "in_progress" and finished, verified steps as "done". Only one step may be in progress.',
    'On the first call also give "goal" and "criteria" (how to tell the task is finished).',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', maxLength: 300, description: 'Short name of what is being built.' },
      criteria: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 }, description: 'Acceptance criteria.' },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', maxLength: 40, description: 'Stable id, for example "1". Keep ids the same between updates.' },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked', 'skipped'] },
          },
          required: ['title'],
        },
      },
    },
    required: ['steps'],
  },
  permission: 'plan',
  showsRow: false,
  describe: () => ({ title: 'Updated the plan' }),
  async execute(args, context) {
    if (!context.plan) return { ok: false, content: 'Error: plans are not used for this task. Continue without one.' };
    const result = context.plan.update(args);
    if (!result.ok) return { ok: false, content: `Error: the plan was not saved:\n- ${result.problems.join('\n- ')}` };
    const note = result.problems.length > 0 ? `\nNotes:\n- ${result.problems.join('\n- ')}` : '';
    return { ok: true, content: `Plan saved: ${result.done} of ${result.total} steps done.${note}` };
  },
};
