import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { ByteAgentError } from '../shared/errors';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * Turns a path supplied by the user or the model into a workspace-relative
 * path with forward slashes. Rejects anything that leaves the workspace,
 * including through `..` segments, absolute paths elsewhere, or symlinks.
 */
export function resolveInWorkspace(root: string, input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ByteAgentError('invalid_arguments', 'A file path is required.');
  }
  if (input.includes('\0')) throw new ByteAgentError('invalid_arguments', 'The path contains an invalid character.');

  let candidate = input.trim().replace(/\\/g, '/');
  // Models sometimes write "file:line"; the line part is not a path.
  candidate = candidate.replace(/^file:\/\//, '');
  const absolute = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative === '') throw new ByteAgentError('invalid_arguments', 'The path points at the workspace folder itself.');
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ByteAgentError('path_outside_workspace', `"${input}" is outside the workspace.`);
  }

  // A symlink inside the workspace may point outside it. Check the deepest
  // part of the path that exists.
  const realRoot = safeRealpath(root) ?? root;
  let probe = absolute;
  for (;;) {
    const real = safeRealpath(probe);
    if (real) {
      const rel = path.relative(realRoot, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new ByteAgentError('path_outside_workspace', `"${input}" resolves to a location outside the workspace.`);
      }
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return toPosix(relative);
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

export function absolutePath(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}

export function extensionOf(relative: string): string {
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function baseName(relative: string): string {
  return relative.slice(relative.lastIndexOf('/') + 1);
}
