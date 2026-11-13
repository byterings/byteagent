import { taskProgress, type TaskState } from '../agent/taskState';
import type { StoredVerification } from './store';

export const TASKS_START = '<!-- byteagent:tasks:start -->';
export const TASKS_END = '<!-- byteagent:tasks:end -->';

const MAX_TASKS = 20;

function day(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

const MARK: Record<string, string> = { done: 'x', in_progress: '~', blocked: '!', skipped: '-', pending: ' ' };

/**
 * The task section of the status document, rendered from stored state.
 * Check results come only from recorded command runs.
 */
export function renderTaskSection(tasks: TaskState[], verifications: StoredVerification[]): string {
  const shown = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, MAX_TASKS);
  if (shown.length === 0) return 'No tracked tasks yet.';
  const blocks = shown.map((task) => {
    const { done, total } = taskProgress(task);
    const lines = [`### ${task.title}`, `- Status: ${task.status.replace(/_/g, ' ')}${total > 0 ? ` (${done} of ${total} steps done)` : ''}`, `- Last updated: ${day(task.updatedAt)}`];
    if (task.steps.length > 0) lines.push('- Steps:', ...task.steps.map((s) => `  - [${MARK[s.status] ?? ' '}] ${s.title}`));
    const files = Object.keys(task.files).sort();
    if (files.length > 0) lines.push(`- Files changed: ${files.map((f) => `\`${f}\``).join(', ')}`);
    // The latest run of each check command for this task.
    const latest = new Map<string, StoredVerification>();
    for (const v of verifications) if (v.taskId === task.id && v.isCheck && v.status !== 'denied') latest.set(v.command, v);
    if (latest.size > 0) {
      lines.push('- Checks run:', ...[...latest.values()].map((v) => `  - \`${v.command}\`: ${v.status === 'done' ? `exit code ${v.exitCode}` : v.status} on ${day(v.createdAt)}`));
    } else lines.push('- Checks run: none recorded');
    return lines.join('\n');
  });
  const more = tasks.length > shown.length ? `\n\n${tasks.length - shown.length} older tasks are not listed.` : '';
  return `${blocks.join('\n\n')}${more}`;
}

/**
 * Replaces the generated section of a status document. Returns undefined
 * when the document has no markers (it is then left entirely alone) or
 * when nothing would change.
 */
export function syncStatusDocument(current: string, section: string): string | undefined {
  const start = current.indexOf(TASKS_START);
  const end = current.indexOf(TASKS_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  const next = `${current.slice(0, start + TASKS_START.length)}\n${section}\n${current.slice(end)}`;
  return next === current ? undefined : next;
}
