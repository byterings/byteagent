import { execFile } from 'node:child_process';
import type { WorkspaceIndex } from '../../context/workspaceIndex';
import type { ToolDefinition } from '../types';

const GIT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 8 * 1024 * 1024;

interface GitOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
  missing: boolean;
}

/** Runs git with fixed arguments, never through a shell. */
function git(cwd: string, args: string[], signal: AbortSignal): Promise<GitOutput> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-pager', '-c', 'core.quotepath=off', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        const missing = Boolean(error && (error as NodeJS.ErrnoException).code === 'ENOENT');
        resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), missing });
      },
    );
  });
}

function notARepo(output: GitOutput): string | undefined {
  if (output.missing) return 'Git is not installed or not on the PATH.';
  if (/not a git repository/i.test(output.stderr)) return 'This folder is not a Git repository.';
  return undefined;
}

function allowed(index: WorkspaceIndex, path: string): boolean {
  try {
    index.resolve(path);
    return true;
  } catch {
    return false;
  }
}

/** Removes the sections of a diff that belong to files the agent may not see. */
export function filterDiff(diff: string, isAllowed: (path: string) => boolean): { text: string; hidden: string[] } {
  const hidden: string[] = [];
  const kept: string[] = [];
  const sections = diff.split(/^(?=diff --git )/m);
  for (const section of sections) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    if (!header) {
      if (section.trim()) kept.push(section);
      continue;
    }
    const paths = [header[1] as string, header[2] as string];
    if (paths.every(isAllowed)) kept.push(section);
    else hidden.push(header[2] as string);
  }
  return { text: kept.join(''), hidden };
}

export const gitStatusTool: ToolDefinition<Record<string, never>> = {
  name: 'git_status',
  description: 'Show the current Git branch and which files are modified, staged or untracked. Read-only.',
  parameters: { type: 'object', properties: {} },
  permission: 'read',
  showsRow: true,
  describe: () => ({ title: 'Checked Git status' }),
  async execute(_args, context) {
    const output = await git(context.index.root, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'], context.signal);
    const problem = notARepo(output);
    if (problem) return { ok: false, content: problem, detail: 'no repository' };
    if (!output.ok) return { ok: false, content: `git status failed: ${output.stderr.trim().slice(0, 300)}`, detail: 'failed' };
    const lines = output.stdout.split('\n').filter(Boolean);
    const branch = lines.find((l) => l.startsWith('## '))?.slice(3) ?? 'unknown';
    const files = lines.filter((l) => !l.startsWith('## '));
    if (files.length === 0) return { ok: true, content: `Branch: ${branch}\nThe working tree is clean.`, detail: 'clean' };
    const shown = files.slice(0, 200);
    const note = files.length > shown.length ? `\n[${files.length - shown.length} more entries not shown]` : '';
    return {
      ok: true,
      content: `Branch: ${branch}\nChanged files (XY path; X = staged, Y = working tree, ?? = untracked):\n${shown.join('\n')}${note}`,
      detail: `${files.length} changed`,
    };
  },
};

export const gitDiffTool: ToolDefinition<{ path?: string; staged?: boolean }> = {
  name: 'git_diff',
  description: 'Show uncommitted changes as a unified diff. Set staged to true for staged changes, and path to limit the diff to one file or folder. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file or folder. Optional.' },
      staged: { type: 'boolean', description: 'Show staged changes instead of unstaged ones. Default false.' },
    },
  },
  permission: 'read',
  showsRow: true,
  describe: (args) => ({ title: `Viewed ${args.staged ? 'staged ' : ''}Git diff${args.path ? ` of ${args.path}` : ''}` }),
  async execute(args, context) {
    const gitArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
    if (args.staged) gitArgs.push('--staged');
    if (args.path && args.path.trim() && args.path.trim() !== '.') {
      // A blocked path is refused outright.
      const rel = context.index.resolve(args.path, { directory: !/\.[A-Za-z0-9]+$/.test(args.path) });
      gitArgs.push('--', rel);
    }
    const output = await git(context.index.root, gitArgs, context.signal);
    const problem = notARepo(output);
    if (problem) return { ok: false, content: problem, detail: 'no repository' };
    if (!output.ok) return { ok: false, content: `git diff failed: ${output.stderr.trim().slice(0, 300)}`, detail: 'failed' };
    if (!output.stdout.trim()) return { ok: true, content: `No ${args.staged ? 'staged' : 'unstaged'} changes.`, detail: 'no changes' };

    const filtered = filterDiff(output.stdout, (p) => allowed(context.index, p));
    const fileCount = (filtered.text.match(/^diff --git /gm) ?? []).length;
    const note = filtered.hidden.length > 0 ? `\n[Changes in ${filtered.hidden.length} excluded or sensitive file${filtered.hidden.length === 1 ? '' : 's'} are not shown.]` : '';
    if (!filtered.text.trim()) return { ok: true, content: `No changes in files available to ByteAgent.${note}`, detail: 'no visible changes' };
    return { ok: true, content: `${filtered.text.trimEnd()}${note}`, detail: `${fileCount} file${fileCount === 1 ? '' : 's'}` };
  },
};
