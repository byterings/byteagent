import { searchText } from '../../context/search';
import { estimateTokens } from '../../shared/tokens';
import type { ToolDefinition } from '../types';

const MAX_READ_LINES = 400;
const MAX_READ_TOKENS = 5000;
const MAX_SEARCH_RESULTS = 60;
const MAX_LIST_ENTRIES = 200;

export const readFileTool: ToolDefinition<{ path: string; start_line?: number; end_line?: number }> = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns the content with its line range. Large files are returned in parts: pass start_line and end_line to read a specific range.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: 'Workspace-relative path, for example src/app.ts' },
      start_line: { type: 'integer', minimum: 1, description: 'First line to read (1-based). Optional.' },
      end_line: { type: 'integer', minimum: 1, description: 'Last line to read (inclusive). Optional.' },
    },
    required: ['path'],
  },
  permission: 'read',
  showsRow: true,
  describe: (args) => ({
    title: `Read ${args.path}${args.start_line ? `:${args.start_line}${args.end_line ? `-${args.end_line}` : ''}` : ''}`,
    path: args.path,
  }),
  async execute(args, context) {
    const whole = await context.index.readText(args.path);
    context.record.filesRead.add(whole.path);
    const lines = whole.text.split('\n');
    const total = whole.lineCount;
    if (total === 0) return { ok: true, content: `File: ${whole.path} (empty file)`, detail: 'empty' };

    let start = Math.min(args.start_line ?? 1, total);
    let end = Math.min(args.end_line ?? total, total);
    if (end < start) [start, end] = [end, start];
    end = Math.min(end, start + MAX_READ_LINES - 1);

    let text = lines.slice(start - 1, end).join('\n');
    // Very long lines can make a small range huge.
    while (estimateTokens(text) > MAX_READ_TOKENS && end > start) {
      end = start + Math.max(1, Math.floor((end - start) / 2));
      text = lines.slice(start - 1, end).join('\n');
    }
    if (estimateTokens(text) > MAX_READ_TOKENS) text = `${text.slice(0, MAX_READ_TOKENS * 3)}\n[line shortened]`;

    const partial = start > 1 || end < total;
    const header = `File: ${whole.path} (lines ${start}-${end} of ${total})${whole.source === 'editor' ? ' [includes unsaved editor changes]' : ''}`;
    const footer = end < total ? `\n[More lines follow. Call read_file with start_line=${end + 1} to continue.]` : '';
    return {
      ok: true,
      content: `${header}\n${text}${footer}`,
      detail: partial ? `lines ${start}-${end} of ${total}` : `${total} line${total === 1 ? '' : 's'}`,
    };
  },
};

export const searchFilesTool: ToolDefinition<{ query: string; regex?: boolean; case_sensitive?: boolean; path?: string }> = {
  name: 'search_files',
  description:
    'Search the contents of workspace files. Returns matching lines as "path:line: text". The query is literal text unless regex is true. Use this to find where something is defined or used.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 300, description: 'Text or regular expression to search for.' },
      regex: { type: 'boolean', description: 'Treat the query as a regular expression. Default false.' },
      case_sensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
      path: { type: 'string', description: 'Only search inside this folder or file. Optional.' },
    },
    required: ['query'],
  },
  permission: 'read',
  showsRow: true,
  describe: (args) => ({ title: `Searched for "${args.query.length > 48 ? `${args.query.slice(0, 48)}…` : args.query}"${args.path ? ` in ${args.path}` : ''}` }),
  async execute(args, context) {
    let prefix: string | undefined;
    if (args.path && args.path.trim() && args.path.trim() !== '.') {
      // Validates the path; a blocked folder is refused rather than silently empty.
      prefix = context.index.resolve(args.path, { directory: !/\.[A-Za-z0-9]+$/.test(args.path) });
    }
    const result = await searchText(context.index, args.query, {
      regex: args.regex,
      caseSensitive: args.case_sensitive,
      pathPrefix: prefix,
      maxResults: MAX_SEARCH_RESULTS,
      maxMatchesPerFile: 12,
      ripgrepPath: context.ripgrepPath,
      signal: context.signal,
    });
    if (result.matches.length === 0) {
      return { ok: true, content: `No matches for "${args.query}"${prefix ? ` in ${prefix}` : ''}.`, detail: 'no matches' };
    }
    const fileCount = new Set(result.matches.map((m) => m.path)).size;
    const body = result.matches.map((m) => `${m.path}:${m.line}: ${m.text.trim()}`).join('\n');
    const note = result.truncated ? `\n[Only the first ${MAX_SEARCH_RESULTS} matches are shown. Narrow the query or set path.]` : '';
    return {
      ok: true,
      content: `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} in ${fileCount} file${fileCount === 1 ? '' : 's'}:\n${body}${note}`,
      detail: `${result.matches.length}${result.truncated ? '+' : ''} match${result.matches.length === 1 ? '' : 'es'}`,
    };
  },
};

export const listDirectoryTool: ToolDefinition<{ path?: string }> = {
  name: 'list_directory',
  description: 'List the files and folders directly inside a workspace folder. Folders end with "/". Omit path to list the workspace root.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative folder. Omit or use "." for the root.' } },
  },
  permission: 'read',
  showsRow: true,
  describe: (args) => ({ title: `Listed ${args.path && args.path !== '.' ? args.path : 'workspace root'}` }),
  async execute(args, context) {
    await context.index.ensureFresh();
    const entries = await context.index.listDirectory(args.path ?? '.');
    if (entries.length === 0) return { ok: true, content: 'The folder is empty (or everything in it is excluded).', detail: 'empty' };
    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    const body = shown.map((e) => (e.type === 'directory' ? `${e.name}/` : e.size !== undefined ? `${e.name}  (${formatSize(e.size)})` : e.name)).join('\n');
    const note = entries.length > shown.length ? `\n[${entries.length - shown.length} more entries not shown]` : '';
    return { ok: true, content: `${body}${note}`, detail: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` };
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
