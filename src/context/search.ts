import { spawn, spawnSync } from 'node:child_process';
import { ByteAgentError } from '../shared/errors';
import { baseName, toPosix } from './paths';
import type { WorkspaceIndex } from './workspaceIndex';

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  /** Only search paths starting with this workspace-relative prefix. */
  pathPrefix?: string;
  maxResults?: number;
  maxMatchesPerFile?: number;
  /** Path to a ripgrep binary. When absent, files are scanned in-process. */
  ripgrepPath?: string;
  signal?: AbortSignal;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when more matches exist than were returned. */
  truncated: boolean;
  engine: 'ripgrep' | 'scan';
}

const MAX_LINE_LENGTH = 240;

function buildMatcher(query: string, options: SearchOptions): RegExp {
  if (!query) throw new ByteAgentError('invalid_arguments', 'The search text is empty.');
  const flags = options.caseSensitive ? '' : 'i';
  if (!options.regex) return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  try {
    return new RegExp(query, flags);
  } catch (err) {
    throw new ByteAgentError('invalid_arguments', `Invalid regular expression: ${(err as Error).message}`);
  }
}

function clip(line: string): string {
  const trimmed = line.replace(/\r$/, '');
  return trimmed.length > MAX_LINE_LENGTH ? `${trimmed.slice(0, MAX_LINE_LENGTH)}…` : trimmed;
}

/**
 * Searches file contents. Only files in the index are ever reported, so
 * excluded and sensitive files cannot appear whichever engine runs.
 */
export async function searchText(index: WorkspaceIndex, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const matcher = buildMatcher(query, options);
  await index.ensureFresh();
  if (options.ripgrepPath) {
    try {
      return await searchWithRipgrep(index, query, options);
    } catch (err) {
      if (err instanceof ByteAgentError) throw err;
      // ripgrep missing or failed: the in-process scan gives the same answer.
    }
  }
  return searchByScan(index, matcher, options);
}

async function searchByScan(index: WorkspaceIndex, matcher: RegExp, options: SearchOptions): Promise<SearchResult> {
  const maxResults = options.maxResults ?? 100;
  const perFile = options.maxMatchesPerFile ?? 20;
  const prefix = options.pathPrefix ? options.pathPrefix.replace(/\/+$/, '') : '';
  const matches: SearchMatch[] = [];
  let truncated = false;

  const files = index
    .textFiles()
    .filter((f) => !prefix || f.path === prefix || f.path.startsWith(`${prefix}/`))
    .sort((a, b) => a.path.localeCompare(b.path));

  outer: for (const file of files) {
    if (options.signal?.aborted) throw new ByteAgentError('cancelled', 'Stopped.');
    let text: string;
    try {
      text = (await index.readText(file.path)).text;
    } catch {
      continue; // unreadable, binary, or changed since the scan
    }
    if (!matcher.test(text)) continue;
    const lines = text.split('\n');
    let inFile = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!matcher.test(lines[i] as string)) continue;
      if (matches.length >= maxResults) {
        truncated = true;
        break outer;
      }
      matches.push({ path: file.path, line: i + 1, text: clip(lines[i] as string) });
      inFile += 1;
      if (inFile >= perFile) break;
    }
  }
  return { matches, truncated, engine: 'scan' };
}

function searchWithRipgrep(index: WorkspaceIndex, query: string, options: SearchOptions): Promise<SearchResult> {
  const maxResults = options.maxResults ?? 100;
  const perFile = options.maxMatchesPerFile ?? 20;
  const args = ['--json', '--no-messages', '--hidden', '--max-count', String(perFile), '--max-columns', '2000'];
  if (!options.caseSensitive) args.push('--ignore-case');
  if (!options.regex) args.push('--fixed-strings');
  args.push('-e', query, '--', options.pathPrefix ? options.pathPrefix : '.');

  return new Promise((resolve, reject) => {
    const child = spawn(options.ripgrepPath as string, args, { cwd: index.root, stdio: ['ignore', 'pipe', 'pipe'] });
    const matches: SearchMatch[] = [];
    let truncated = false;
    let buffer = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve({ matches: matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line), truncated, engine: 'ripgrep' });
    };
    const onAbort = (): void => {
      child.kill();
      finish(new ByteAgentError('cancelled', 'Stopped.'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== 'match' || !event.data?.path?.text) continue;
        const rel = toPosix(event.data.path.text).replace(/^\.\//, '');
        // The index is the authority on what the agent may see.
        if (!index.has(rel)) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          child.kill();
          return;
        }
        matches.push({ path: rel, line: event.data.line_number ?? 0, text: clip((event.data.lines?.text ?? '').replace(/\n$/, '')) });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      // 0 = matches, 1 = no matches, null = killed by us after enough results.
      if (code === 2 && matches.length === 0) {
        if (/regex parse error|unclosed|repetition/i.test(stderr)) {
          finish(new ByteAgentError('invalid_arguments', 'Invalid regular expression.'));
        } else finish(new Error(stderr || 'ripgrep failed'));
        return;
      }
      finish();
    });
  });
}

let ripgrepProbe: { candidates: string; path: string | undefined } | undefined;

/** Returns the first working ripgrep binary among the candidates. */
export function findRipgrep(candidates: string[]): string | undefined {
  const key = candidates.join('|');
  if (ripgrepProbe?.candidates === key) return ripgrepProbe.path;
  let found: string | undefined;
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['--version'], { timeout: 3000, encoding: 'utf8' });
      if (result.status === 0 && /ripgrep/i.test(result.stdout)) {
        found = candidate;
        break;
      }
    } catch {
      // try the next candidate
    }
  }
  ripgrepProbe = { candidates: key, path: found };
  return found;
}

/** Finds files by name or path fragment, best matches first. */
export function findFiles(index: WorkspaceIndex, query: string, limit = 20): string[] {
  const q = query.trim().toLowerCase().replace(/\\/g, '/');
  const files = index.files();
  if (!q) {
    return files
      .slice()
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((f) => f.path);
  }
  const scored: Array<{ path: string; score: number }> = [];
  for (const file of files) {
    const lower = file.path.toLowerCase();
    const name = baseName(lower);
    let score = 0;
    if (lower === q) score = 1000;
    else if (name === q) score = 900;
    else if (name.startsWith(q)) score = 700 - name.length;
    else if (name.includes(q)) score = 500 - name.length;
    else if (lower.endsWith(q)) score = 450;
    else if (lower.includes(q)) score = 300 - lower.length * 0.1;
    else if (isSubsequence(q, lower)) score = 100 - lower.length * 0.1;
    if (score > 0) scored.push({ path: file.path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((s) => s.path);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}
