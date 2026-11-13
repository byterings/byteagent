import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { absolutePath } from '../context/paths';
import type { WorkspaceIndex } from '../context/workspaceIndex';
import { ByteAgentError } from '../shared/errors';
import { expectedHash } from './proposal';
import type { ApplyResult, ChangeIO, ChangeSet, ReviewDecision } from './types';

/** Writes straight to disk. Used by tests and when no editor is involved. */
export class NodeChangeIO implements ChangeIO {
  constructor(private readonly root: string) {}

  async write(relativePath: string, content: string): Promise<void> {
    const target = absolutePath(this.root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Write beside the target, then rename, so a crash never leaves half a file.
    const temp = `${target}.byteagent-${process.pid}-${Date.now()}.tmp`;
    let mode: number | undefined;
    try {
      mode = (await fs.stat(target)).mode;
    } catch {
      mode = undefined;
    }
    try {
      await fs.writeFile(temp, content, { encoding: 'utf8', mode });
      await fs.rename(temp, target);
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async delete(relativePath: string): Promise<void> {
    await fs.rm(absolutePath(this.root, relativePath));
  }
}

/**
 * Applies the accepted part of a reviewed change set.
 *
 * - A change without an explicit "accept" is not applied.
 * - Each accepted change is re-checked against the exclusion rules and
 *   against the hash captured when the preview was created. A file that
 *   changed since then is reported as stale and left alone.
 * - Exactly the reviewed content is written, then read back and compared.
 * - Every file gets its own result; one failure does not hide another.
 */
export async function applyChangeSet(
  index: WorkspaceIndex,
  changeSet: ChangeSet,
  review: ReviewDecision,
  io: ChangeIO,
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];

  for (const change of changeSet.changes) {
    const base = { changeId: change.id, path: change.path, kind: change.kind };
    if (review.decisions[change.id] !== 'accept') {
      results.push({ ...base, status: 'rejected' });
      continue;
    }

    try {
      // The policy may have changed since the preview (settings, .gitignore).
      index.resolve(change.path);

      const current = await index.currentHash(change.path);
      if (current !== change.baseHash) {
        results.push({
          ...base,
          status: 'stale',
          error:
            change.kind === 'create'
              ? 'A file now exists at this path. It was not overwritten.'
              : 'The file changed after this preview was created. It was not overwritten.',
        });
        continue;
      }

      if (change.newContent === null) await io.delete(change.path);
      else await io.write(change.path, change.newContent);

      index.invalidate(change.path);
      const written = await index.currentHash(change.path);
      if (written !== expectedHash(change)) {
        results.push({ ...base, status: 'failed', error: 'The file on disk does not match the approved content after writing.' });
      } else {
        results.push({ ...base, status: 'applied' });
      }
    } catch (err) {
      results.push({
        ...base,
        status: 'failed',
        error: err instanceof ByteAgentError ? err.message : describeIoError(err),
      });
    } finally {
      await index.refreshPath(change.path).catch(() => undefined);
    }
  }
  return results;
}

function describeIoError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied.';
  if (code === 'ENOSPC') return 'The disk is full.';
  if (code === 'EROFS') return 'The file system is read-only.';
  if (code === 'EISDIR') return 'The path is a folder.';
  if (code === 'ENOENT') return 'The file or its folder no longer exists.';
  return err instanceof Error ? err.message : String(err);
}
