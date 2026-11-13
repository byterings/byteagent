import { diffLines } from 'diff';
import { promises as fs } from 'node:fs';
import { absolutePath } from '../context/paths';
import type { WorkspaceIndex } from '../context/workspaceIndex';
import { ByteAgentError } from '../shared/errors';
import { ABSENT_HASH, newId, sha256 } from '../shared/hash';
import type { ChangeOperation, ChangeSet, ProposedChange } from './types';

export const MAX_FILES_PER_CHANGE_SET = 40;
const MAX_CONTENT_BYTES = 1024 * 1024;

interface Working {
  path: string;
  baseContent: string | null;
  baseHash: string;
  /** Current result of the operations applied so far; null means deleted. */
  content: string | null;
}

export function countDiff(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(search, from);
    if (at === -1) return count;
    count += 1;
    from = at + search.length;
  }
}

/** Applies one search-and-replace edit, or explains exactly why it cannot. */
function applyEdit(path: string, text: string, edit: { search: string; replace: string; replaceAll?: boolean }, position: number): string {
  let { search, replace } = edit;
  if (typeof search !== 'string' || search.length === 0) {
    throw new ByteAgentError('invalid_arguments', `${path}: edit ${position} has an empty "search" text.`);
  }
  if (typeof replace !== 'string') {
    throw new ByteAgentError('invalid_arguments', `${path}: edit ${position} is missing "replace".`);
  }
  // Files with Windows line endings: accept search text written with "\n".
  if (text.includes('\r\n') && !search.includes('\r\n') && countOccurrences(text, search) === 0) {
    search = search.replace(/\n/g, '\r\n');
    replace = replace.replace(/\r?\n/g, '\r\n');
  }
  const count = countOccurrences(text, search);
  if (count === 0) {
    throw new ByteAgentError(
      'invalid_arguments',
      `${path}: edit ${position} "search" text was not found. It must match the file exactly, including spaces and indentation. Read the file again and copy the text from it.`,
    );
  }
  if (count > 1 && !edit.replaceAll) {
    throw new ByteAgentError(
      'invalid_arguments',
      `${path}: edit ${position} "search" text matches ${count} places. Include more surrounding lines so it matches once, or set "replaceAll" to true.`,
    );
  }
  return edit.replaceAll ? text.split(search).join(replace) : text.replace(search, () => replace);
}

/**
 * Turns the model's operations into a reviewable change set. Every path is
 * validated against the workspace and exclusion rules, and the content each
 * change is based on is hashed. Any problem rejects the whole proposal, so
 * a half-valid set is never shown for review.
 */
export async function buildChangeSet(index: WorkspaceIndex, operations: ChangeOperation[], summary: string): Promise<ChangeSet> {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ByteAgentError('invalid_arguments', 'No changes were given.');
  }

  const working = new Map<string, Working>();
  const problems: string[] = [];

  const load = async (inputPath: string): Promise<Working> => {
    const rel = index.resolve(inputPath);
    const existing = working.get(rel);
    if (existing) return existing;
    let entry: Working;
    try {
      const file = await index.readText(rel);
      entry = { path: rel, baseContent: file.text, baseHash: file.hash, content: file.text };
    } catch (err) {
      if (err instanceof ByteAgentError && err.code === 'not_found') {
        entry = { path: rel, baseContent: null, baseHash: ABSENT_HASH, content: null };
      } else {
        throw err;
      }
    }
    working.set(rel, entry);
    return entry;
  };

  for (const op of operations) {
    try {
      if (!op || typeof op !== 'object' || typeof op.path !== 'string') {
        throw new ByteAgentError('invalid_arguments', 'Each change needs a "path".');
      }
      if (op.type === 'write') {
        if (typeof op.content !== 'string') throw new ByteAgentError('invalid_arguments', `${op.path}: "content" must be text.`);
        if (Buffer.byteLength(op.content, 'utf8') > MAX_CONTENT_BYTES) {
          throw new ByteAgentError('file_too_large', `${op.path}: the new content is over 1 MB.`);
        }
        const entry = await load(op.path);
        if (entry.baseContent === null) {
          // Creating a file where a folder exists cannot work.
          const stat = await fs.stat(absolutePath(index.root, entry.path)).catch(() => undefined);
          if (stat?.isDirectory()) throw new ByteAgentError('invalid_arguments', `${entry.path} is a folder.`);
        }
        entry.content = op.content;
      } else if (op.type === 'edit') {
        if (!Array.isArray(op.edits) || op.edits.length === 0) {
          throw new ByteAgentError('invalid_arguments', `${op.path}: "edits" must contain at least one edit.`);
        }
        const entry = await load(op.path);
        if (entry.content === null) {
          throw new ByteAgentError('not_found', `${entry.path} does not exist, so it cannot be edited. Use a write to create it.`);
        }
        let text = entry.content;
        op.edits.forEach((edit, i) => {
          text = applyEdit(entry.path, text, edit, i + 1);
        });
        entry.content = text;
      } else if (op.type === 'delete') {
        const entry = await load(op.path);
        if (entry.baseContent === null) throw new ByteAgentError('not_found', `${entry.path} does not exist, so it cannot be deleted.`);
        entry.content = null;
      } else {
        throw new ByteAgentError('invalid_arguments', `Unknown change type "${String((op as { type?: unknown }).type)}". Use write, edit or delete.`);
      }
    } catch (err) {
      problems.push(err instanceof ByteAgentError ? err.message : `${String((op as { path?: unknown })?.path ?? 'change')}: ${(err as Error).message}`);
    }
  }

  if (problems.length > 0) {
    throw new ByteAgentError('invalid_arguments', `The proposal was not shown to the user because of ${problems.length === 1 ? 'a problem' : 'problems'}:\n- ${problems.join('\n- ')}`, { problems });
  }

  const changes: ProposedChange[] = [];
  for (const entry of working.values()) {
    if (entry.content === entry.baseContent) continue; // no effective change
    const before = entry.baseContent ?? '';
    const after = entry.content ?? '';
    const stats = countDiff(before, after);
    changes.push({
      id: newId('c'),
      path: entry.path,
      kind: entry.baseContent === null ? 'create' : entry.content === null ? 'delete' : 'modify',
      baseHash: entry.baseHash,
      baseContent: entry.baseContent,
      newContent: entry.content,
      added: stats.added,
      removed: stats.removed,
    });
  }

  if (changes.length === 0) {
    throw new ByteAgentError('invalid_arguments', 'The proposed changes leave every file exactly as it is. Nothing to review.');
  }
  if (changes.length > MAX_FILES_PER_CHANGE_SET) {
    throw new ByteAgentError('invalid_arguments', `A proposal may touch at most ${MAX_FILES_PER_CHANGE_SET} files. Split the work into smaller steps.`);
  }

  // Review in a stable order: edits first, then new files, deletions last.
  const order = { modify: 0, create: 1, delete: 2 } as const;
  changes.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
  return { id: newId('cs'), summary: summary.trim().slice(0, 300), changes, createdAt: Date.now() };
}

/** Hash a change would produce on disk, for verification after writing. */
export function expectedHash(change: ProposedChange): string {
  return change.newContent === null ? ABSENT_HASH : sha256(change.newContent);
}
