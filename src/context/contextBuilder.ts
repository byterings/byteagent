import { ByteAgentError } from '../shared/errors';
import type { Attachment, ExecutionMode } from '../shared/protocol';
import { estimateTokens, truncateToTokens } from '../shared/tokens';
import { describeBlock, type BlockReason } from './ignore';
import { rankFiles, type RankedFile } from './ranker';
import type { WorkspaceIndex } from './workspaceIndex';

export interface ContextRequest {
  prompt: string;
  attachments: Attachment[];
  activeFile?: string;
  openFiles?: string[];
  mode: ExecutionMode;
  /** Tokens this package may use. */
  budgetTokens: number;
  ripgrepPath?: string;
  signal?: AbortSignal;
}

export interface ContextFile {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  tokens: number;
  reason: string;
  /** True when only part of the file (or of the requested range) is included. */
  truncated: boolean;
  /** Hash of the whole file at the time it was read. */
  hash: string;
}

export interface OmittedFile {
  path: string;
  reason: string;
}

export interface ContextPackage {
  files: ContextFile[];
  omitted: OmittedFile[];
  totalTokens: number;
  budget: number;
  /** The block that is placed in the prompt. Empty when no files were selected. */
  rendered: string;
}

interface ModeLimits {
  maxFiles: number;
  /** Largest share of the budget one file may take. */
  perFileShare: number;
  budgetCap: number;
}

export const MODE_LIMITS: Record<ExecutionMode, ModeLimits> = {
  quick: { maxFiles: 4, perFileShare: 0.6, budgetCap: 6000 },
  standard: { maxFiles: 8, perFileShare: 0.4, budgetCap: 16000 },
  project: { maxFiles: 12, perFileShare: 0.3, budgetCap: 24000 },
};

const MIN_USEFUL_TOKENS = 120;
const MAX_OMITTED_LISTED = 15;
const EXCERPT_RADIUS = 14;

export interface BudgetInput {
  contextWindow: number;
  /** Tokens reserved for the model's answer. */
  maxOutputTokens?: number;
  /** Tokens already committed: system prompt, history, the request itself. */
  fixedTokens: number;
  mode: ExecutionMode;
}

/**
 * How many tokens the context package may use. Output capacity and a
 * safety margin are reserved first; the rest is shared between context
 * and the tool results the model will ask for later.
 */
export function computeContextBudget(input: BudgetInput): number {
  const reservedOutput = input.maxOutputTokens ?? Math.min(4096, Math.floor(input.contextWindow * 0.25));
  const safety = Math.ceil(input.contextWindow * 0.05);
  const available = input.contextWindow - reservedOutput - safety - input.fixedTokens;
  if (available <= 0) return 0;
  return Math.max(0, Math.min(MODE_LIMITS[input.mode].budgetCap, Math.floor(available * 0.5)));
}

function excerptAround(lines: string[], matchLines: number[], maxTokens: number): { text: string; start: number; end: number } | undefined {
  if (matchLines.length === 0) return undefined;
  const sorted = [...new Set(matchLines)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const line of sorted) {
    const from = Math.max(1, line - EXCERPT_RADIUS);
    const to = Math.min(lines.length, line + EXCERPT_RADIUS);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 3) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  const parts: string[] = [];
  let used = 0;
  let first = 0;
  let lastLine = 0;
  for (const [from, to] of ranges) {
    const chunk = lines.slice(from - 1, to).join('\n');
    const header = `[lines ${from}-${to}]`;
    const cost = estimateTokens(chunk) + 6;
    if (used + cost > maxTokens) {
      if (parts.length === 0) {
        const cut = truncateToTokens(chunk, maxTokens - 6);
        parts.push(`${header}\n${cut.text}`);
        first = from;
        lastLine = from + cut.text.split('\n').length - 1;
      }
      break;
    }
    parts.push(`${header}\n${chunk}`);
    used += cost;
    if (!first) first = from;
    lastLine = to;
  }
  return parts.length > 0 ? { text: parts.join('\n[…]\n'), start: first, end: lastLine } : undefined;
}

function reasonFor(error: unknown): string {
  if (error instanceof ByteAgentError) {
    switch (error.code) {
      case 'path_sensitive':
      case 'path_excluded':
        return describeBlock(error.details?.reason as BlockReason | undefined);
      case 'path_outside_workspace':
        return 'outside the workspace';
      case 'file_too_large':
        return 'over the file size limit';
      case 'binary_file':
        return 'binary file';
      case 'not_found':
        return 'file not found';
      default:
        return error.message;
    }
  }
  return 'could not be read';
}

/**
 * Selects and trims the files sent with a request. Nothing is included
 * without a recorded reason, and everything left out is listed.
 */
export async function buildContext(index: WorkspaceIndex, request: ContextRequest): Promise<ContextPackage> {
  const limits = MODE_LIMITS[request.mode];
  const budget = Math.max(0, Math.floor(request.budgetTokens));
  const files: ContextFile[] = [];
  const omitted: OmittedFile[] = [];
  const omit = (path: string, reason: string): void => {
    if (!omitted.some((o) => o.path === path)) omitted.push({ path, reason });
  };

  let ranked: RankedFile[];
  try {
    ranked = await rankFiles(index, {
      prompt: request.prompt,
      attachments: request.attachments,
      activeFile: request.activeFile,
      openFiles: request.openFiles,
      contentSearch: true,
      ripgrepPath: request.ripgrepPath,
      signal: request.signal,
    });
  } catch (err) {
    if (err instanceof ByteAgentError && err.code === 'cancelled') throw err;
    ranked = [];
  }

  let used = 0;
  const perFileCap = Math.max(MIN_USEFUL_TOKENS, Math.floor(budget * limits.perFileShare));

  for (const candidate of ranked) {
    const reason = candidate.reasons.slice(0, 2).join(', ');
    if (!candidate.pinned && files.length >= limits.maxFiles) {
      omit(candidate.path, 'lower relevance');
      continue;
    }

    let file;
    try {
      file = await index.readText(candidate.path);
    } catch (err) {
      // Blocked or unreadable files are reported, never silently skipped.
      omit(candidate.path, reasonFor(err));
      continue;
    }

    const remaining = budget - used;
    if (remaining < MIN_USEFUL_TOKENS) {
      omit(file.path, 'token budget used up');
      continue;
    }
    const cap = Math.min(remaining, candidate.pinned ? Math.max(perFileCap, Math.floor(budget * 0.7)) : perFileCap);

    const allLines = file.text.split('\n');
    let text: string;
    let startLine = 1;
    let endLine = file.lineCount;
    let truncated = false;

    if (candidate.startLine && candidate.endLine) {
      startLine = Math.max(1, Math.min(candidate.startLine, allLines.length));
      endLine = Math.max(startLine, Math.min(candidate.endLine, allLines.length));
      text = allLines.slice(startLine - 1, endLine).join('\n');
      const cut = truncateToTokens(text, cap);
      if (cut.truncated) {
        text = cut.text;
        endLine = startLine + text.split('\n').length - 1;
        truncated = true;
      }
    } else if (estimateTokens(file.text) <= cap) {
      text = file.text;
    } else {
      const excerpt = excerptAround(allLines, candidate.matchLines, cap);
      if (excerpt) {
        text = excerpt.text;
        startLine = excerpt.start;
        endLine = excerpt.end;
      } else {
        const cut = truncateToTokens(file.text, cap);
        text = cut.text;
        endLine = text.split('\n').length;
      }
      truncated = true;
    }

    const tokens = estimateTokens(text) + 12;
    if (text.trim() === '' && file.text.trim() !== '') {
      omit(file.path, 'token budget used up');
      continue;
    }
    files.push({ path: file.path, text, startLine, endLine, totalLines: file.lineCount, tokens, reason, truncated, hash: file.hash });
    used += tokens;
  }

  const listed = omitted.slice(0, MAX_OMITTED_LISTED);
  if (omitted.length > MAX_OMITTED_LISTED) {
    listed.push({ path: `${omitted.length - MAX_OMITTED_LISTED} more files`, reason: 'lower relevance' });
  }

  return { files, omitted: listed, totalTokens: used, budget, rendered: renderContext(files) };
}

export function renderContext(files: ContextFile[]): string {
  if (files.length === 0) return '';
  const blocks = files.map((file) => {
    const partial = file.truncated || file.startLine > 1 || file.endLine < file.totalLines;
    const range = partial ? ` lines="${file.startLine}-${file.endLine}" of="${file.totalLines}" partial="true"` : '';
    return `<file path="${file.path}"${range}>\n${file.text}\n</file>`;
  });
  return [
    'Project files selected for this request. The selection may be incomplete, and partial files show only some lines. Read more with the tools when needed.',
    ...blocks,
  ].join('\n\n');
}
