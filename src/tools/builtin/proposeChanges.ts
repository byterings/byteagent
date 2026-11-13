import { applyChangeSet } from '../../changes/applier';
import { buildChangeSet } from '../../changes/proposal';
import type { ApplyResult, ChangeOperation, ChangeSet, ReviewDecision } from '../../changes/types';
import { newId } from '../../shared/hash';
import type { ChangeFileView } from '../../shared/protocol';
import type { ToolDefinition } from '../types';

interface ProposeArgs {
  summary?: string;
  changes: Array<{
    path: string;
    action: 'write' | 'edit' | 'delete';
    content?: string;
    edits?: Array<{ search: string; replace: string; replace_all?: boolean }>;
  }>;
}

function toOperations(args: ProposeArgs): ChangeOperation[] {
  return args.changes.map((change): ChangeOperation => {
    if (change.action === 'write') return { type: 'write', path: change.path, content: change.content as string };
    if (change.action === 'delete') return { type: 'delete', path: change.path };
    return {
      type: 'edit',
      path: change.path,
      edits: (change.edits ?? []).map((e) => ({ search: e.search, replace: e.replace, replaceAll: e.replace_all })),
    };
  });
}

function fileViews(changeSet: ChangeSet): ChangeFileView[] {
  return changeSet.changes.map((c) => ({ changeId: c.id, path: c.path, kind: c.kind, added: c.added, removed: c.removed, status: 'pending' }));
}

/** The text the model receives. It states only what actually happened. */
export function describeResults(results: ApplyResult[], feedback: string | undefined): string {
  const lines: string[] = ['Review result:'];
  for (const r of results) {
    if (r.status === 'applied') lines.push(`- APPLIED: ${r.path}${r.kind === 'delete' ? ' (deleted)' : r.kind === 'create' ? ' (created)' : ''}`);
    else if (r.status === 'rejected') lines.push(`- NOT applied, rejected by the user: ${r.path}`);
    else if (r.status === 'stale') lines.push(`- NOT applied, ${r.error ?? 'the file changed after the preview'} Read ${r.path} again before proposing a new change to it.`);
    else lines.push(`- FAILED, not applied: ${r.path}: ${r.error ?? 'unknown error'}`);
  }
  const applied = results.filter((r) => r.status === 'applied').length;
  if (feedback) {
    lines.push(`The user asked for a revision: "${feedback}"`);
    lines.push('Revise the proposal accordingly and call propose_changes again.');
  } else if (applied === 0 && results.every((r) => r.status === 'rejected')) {
    lines.push('The user rejected the proposal. Nothing was changed. Do not propose the same change again. Ask what they would like instead, or stop.');
  }
  if (applied > 0 && applied < results.length) lines.push('Only the files marked APPLIED were changed.');
  return lines.join('\n');
}

export const proposeChangesTool: ToolDefinition<ProposeArgs> = {
  name: 'propose_changes',
  description: [
    'Propose changes to workspace files. This is the only way to change files. The user sees a diff and accepts or rejects each file; nothing is written before that.',
    'Each change has a path and an action:',
    '- "edit": change an existing file with search-and-replace edits. "search" must match the current file text exactly and only once (include enough surrounding lines). Preferred for existing files.',
    '- "write": create a new file, or replace a whole file, with "content".',
    '- "delete": delete a file.',
    'Include every file change for the current step in one call. The result tells you which files were applied.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', maxLength: 300, description: 'One sentence describing the change for the reviewer.' },
      changes: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1, description: 'Workspace-relative path.' },
            action: { type: 'string', enum: ['write', 'edit', 'delete'] },
            content: { type: 'string', description: 'Full file content. Required for "write".' },
            edits: {
              type: 'array',
              description: 'Required for "edit".',
              items: {
                type: 'object',
                properties: {
                  search: { type: 'string', minLength: 1, description: 'Exact text currently in the file.' },
                  replace: { type: 'string', description: 'Text to put in its place.' },
                  replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
                },
                required: ['search', 'replace'],
              },
            },
          },
          required: ['path', 'action'],
        },
      },
    },
    required: ['changes'],
  },
  permission: 'propose',
  showsRow: false,
  describe: (args) => ({ title: `Proposed changes to ${args.changes.length} file${args.changes.length === 1 ? '' : 's'}` }),

  async execute(args, context) {
    for (const change of args.changes) {
      if (change.action === 'write' && typeof change.content !== 'string') {
        return { ok: false, content: `Error: ${change.path}: a "write" needs "content".` };
      }
      if (change.action === 'edit' && (!change.edits || change.edits.length === 0)) {
        return { ok: false, content: `Error: ${change.path}: an "edit" needs at least one entry in "edits".` };
      }
    }

    // Validation problems go back to the model; the user is not shown a broken proposal.
    const changeSet = await buildChangeSet(context.index, toOperations(args), args.summary ?? '');
    context.record.proposals += 1;

    const itemId = newId('ch');
    context.events.add({
      kind: 'changes',
      id: itemId,
      changeSetId: changeSet.id,
      summary: changeSet.summary,
      files: fileViews(changeSet),
      status: 'pending',
    });

    let review: ReviewDecision;
    try {
      review = await context.host.reviewChanges(changeSet, context.signal);
    } catch (err) {
      context.events.update(itemId, {
        status: 'resolved',
        files: fileViews(changeSet).map((f) => ({ ...f, status: 'rejected' })),
      });
      throw err;
    }

    const results = await applyChangeSet(context.index, changeSet, review, context.host.changeIO);

    const byId = new Map(results.map((r) => [r.changeId, r]));
    context.events.update(itemId, {
      status: 'resolved',
      feedback: review.feedback,
      files: fileViews(changeSet).map((f) => {
        const r = byId.get(f.changeId);
        return { ...f, status: r?.status ?? 'rejected', error: r?.status === 'stale' || r?.status === 'failed' ? r.error : undefined };
      }),
    });

    for (const r of results) {
      if (r.status === 'applied') context.record.applied.push(r.path);
      else if (r.status === 'rejected') context.record.rejected.push(r.path);
      else if (r.status === 'stale') context.record.stale.push(r.path);
      else context.record.failed.push({ path: r.path, error: r.error ?? 'unknown error' });
    }
    if (review.feedback) context.record.feedback.push(review.feedback);

    const applied = results.filter((r) => r.status === 'applied').length;
    return { ok: true, content: describeResults(results, review.feedback), detail: `${applied} of ${results.length} applied` };
  },
};
