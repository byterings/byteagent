import type { Attachment } from '../shared/protocol';
import { baseName } from './paths';
import { searchText } from './search';
import type { WorkspaceIndex } from './workspaceIndex';

export interface RankRequest {
  prompt: string;
  attachments: Attachment[];
  activeFile?: string;
  openFiles?: string[];
  /** Search file contents for the request's terms. */
  contentSearch: boolean;
  ripgrepPath?: string;
  signal?: AbortSignal;
}

export interface RankedFile {
  path: string;
  score: number;
  reasons: string[];
  /** Lines that matched request terms, for excerpt selection. */
  matchLines: number[];
  /** Attached by the user: always included when readable. */
  pinned: boolean;
  startLine?: number;
  endLine?: number;
}

export interface Terms {
  /** Identifiers and quoted text: strong evidence. */
  strong: string[];
  /** Ordinary words: weak evidence. */
  weak: string[];
  /** Things that look like file names or paths. */
  paths: string[];
  /** Pieces of identifiers ("order" from "orderTotal"): the weakest evidence. */
  parts: string[];
}

const STOPWORDS = new Set(
  `a an and are as at be but by can could do does for from had has have how i if in into is it its just like make me my need of on or our please should so some than that the their them then there these this to use using want was we what when where which who why will with would you your
   add added adding change changed changes create created update updated fix fixed fixes remove removed delete implement write show tell explain help look find get set run code file files function functions method class project app application work works working issue bug error problem thing something anything new also about all any not now only`
    .split(/\s+/)
    .filter(Boolean),
);

const MIN_SCORE = 20;

/** Pulls search terms out of a request. */
export function extractTerms(prompt: string): Terms {
  const strong = new Set<string>();
  const weak = new Set<string>();
  const paths = new Set<string>();
  const parts = new Set<string>();

  for (const match of prompt.matchAll(/`([^`\n]{2,80})`|"([^"\n]{2,60})"|'([^'\n]{2,60})'/g)) {
    const quoted = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!quoted) continue;
    if (/^[\w./@-]+\.[A-Za-z0-9]{1,8}$/.test(quoted) || quoted.includes('/')) paths.add(quoted.replace(/^\.\//, ''));
    else if (!/\s/.test(quoted)) strong.add(quoted);
  }

  for (const token of prompt.split(/[\s,;()[\]{}<>"'`!?]+/)) {
    const cleaned = token.replace(/^[.:]+|[.:]+$/g, '');
    if (!cleaned) continue;
    const withoutLine = cleaned.replace(/:\d+(-\d+)?$/, '');
    if (/^[\w./@-]*[\w@-]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(withoutLine) && !/^\d+\.\d+$/.test(withoutLine)) {
      paths.add(withoutLine.replace(/^\.\//, ''));
      continue;
    }
    if (withoutLine.includes('/') && /^[\w./@-]+$/.test(withoutLine) && withoutLine.length > 2) {
      paths.add(withoutLine.replace(/^\.\/|\/$/g, ''));
      continue;
    }
    for (const word of cleaned.split(/[^A-Za-z0-9_$]+/)) {
      if (word.length < 3 || /^\d+$/.test(word)) continue;
      const lower = word.toLowerCase();
      const isIdentifier = /[a-z][A-Z]|_|\$|[A-Za-z]\d/.test(word) || /^[A-Z][a-z]+[A-Z]/.test(word);
      if (isIdentifier) {
        strong.add(word);
        for (const part of word.split(/_|(?<=[a-z0-9])(?=[A-Z])/)) {
          const p = part.toLowerCase();
          if (p.length >= 4 && !STOPWORDS.has(p)) parts.add(p);
        }
      } else if (!STOPWORDS.has(lower)) {
        weak.add(lower);
      }
    }
  }
  for (const s of strong) weak.delete(s.toLowerCase());
  for (const w of weak) parts.delete(w);
  for (const s of strong) parts.delete(s.toLowerCase());
  return { strong: [...strong].slice(0, 8), weak: [...weak].slice(0, 10), paths: [...paths].slice(0, 8), parts: [...parts].slice(0, 8) };
}

/** Matches a line that declares `name` in the common languages. */
function definitionPattern(name: string, ignoreCase = false): RegExp | undefined {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
  const n = name.replace(/\$/g, '\\$');
  return new RegExp(
    `\\b(?:function\\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module|namespace|object|record)\\s+${n}\\b` +
      `|\\b${n}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)` +
      `|^\\s*(?:(?:export|public|private|protected|static|async|override|abstract)\\s+)*${n}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`,
    ignoreCase ? 'i' : '',
  );
}

function isTestFile(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) || /[._-](test|spec)\.[a-z0-9]+$/i.test(path) || /(^|\/)test_[^/]+$/.test(path);
}

function stem(path: string): string {
  return baseName(path)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[._-](test|spec)$/i, '')
    .replace(/^test_/, '')
    .toLowerCase();
}

function qualityFactor(path: string, prompt: string): number {
  const name = baseName(path).toLowerCase();
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|cargo\.lock|poetry\.lock|go\.sum)$/i.test(path)) return 0.1;
  if (/\.min\.(js|css)$/.test(name) || /\.(map|snap)$/.test(name)) return 0.1;
  if (/(^|\/)(dist|build|out|coverage|vendor|generated)\//.test(path)) return 0.3;
  if (/\.(md|txt|rst)$/.test(name) && !/\b(readme|docs?|documentation|changelog)\b/i.test(prompt)) return 0.6;
  return 1;
}

/**
 * Orders workspace files by how likely they are to matter for a request.
 * Every file in the result carries the reasons it was chosen; files with
 * no reason are not returned.
 */
export async function rankFiles(index: WorkspaceIndex, request: RankRequest): Promise<RankedFile[]> {
  await index.ensureFresh();
  const terms = extractTerms(request.prompt);
  const mentionsTests = /\b(tests?|specs?|unit tests?|coverage)\b/i.test(request.prompt);
  const ranked = new Map<string, RankedFile>();

  const bump = (path: string, score: number, reason: string, line?: number): void => {
    let entry = ranked.get(path);
    if (!entry) {
      entry = { path, score: 0, reasons: [], matchLines: [], pinned: false };
      ranked.set(path, entry);
    }
    entry.score += score;
    if (reason && !entry.reasons.includes(reason)) entry.reasons.push(reason);
    if (line && entry.matchLines.length < 40 && !entry.matchLines.includes(line)) entry.matchLines.push(line);
  };

  // 1. What the user attached is always first.
  for (const attachment of request.attachments) {
    const reason = attachment.source === 'selection' ? 'your selection' : attachment.source === 'active' ? 'current file' : 'attached by you';
    bump(attachment.path, 1000, reason);
    const entry = ranked.get(attachment.path) as RankedFile;
    entry.pinned = true;
    if (attachment.startLine && attachment.endLine) {
      entry.startLine = attachment.startLine;
      entry.endLine = attachment.endLine;
    }
  }

  const files = index.files();

  // 2. Paths and file names written in the request.
  for (const hint of terms.paths) {
    const lower = hint.toLowerCase();
    for (const file of files) {
      const candidate = file.path.toLowerCase();
      if (candidate === lower || candidate.endsWith(`/${lower}`)) bump(file.path, 120, 'named in your request');
      else if (lower.includes('/') && candidate.startsWith(`${lower}/`)) bump(file.path, 30, `inside ${hint}`);
    }
  }

  // 3. File and folder names that match request terms.
  for (const file of files) {
    const fileStem = stem(file.path);
    const lowerPath = file.path.toLowerCase();
    for (const term of terms.strong) {
      const t = term.toLowerCase();
      if (fileStem === t) bump(file.path, 70, `file name matches "${term}"`);
      else if (fileStem.includes(t)) bump(file.path, 40, `file name contains "${term}"`);
      else if (lowerPath.includes(t)) bump(file.path, 18, `path contains "${term}"`);
    }
    for (const term of terms.weak) {
      if (fileStem === term) bump(file.path, 45, `file name matches "${term}"`);
      else if (fileStem.includes(term) && term.length >= 4) bump(file.path, 22, `file name contains "${term}"`);
      else if (lowerPath.split('/').slice(0, -1).some((segment) => segment === term)) bump(file.path, 10, `in folder "${term}"`);
    }
    for (const part of terms.parts) {
      if (fileStem === part) bump(file.path, 20, `file name matches "${part}"`);
      else if (fileStem.includes(part)) bump(file.path, 8, `file name contains "${part}"`);
    }
  }

  // 4. File contents that mention the terms.
  if (request.contentSearch) {
    const searches: Array<{ term: string; weight: number }> = [
      ...terms.strong.slice(0, 5).map((term) => ({ term, weight: 9 })),
      ...terms.weak.filter((t) => t.length >= 4).slice(0, 5).map((term) => ({ term, weight: 3 })),
    ];
    for (const { term, weight } of searches) {
      let result;
      try {
        result = await searchText(index, term, { maxResults: 150, maxMatchesPerFile: 6, ripgrepPath: request.ripgrepPath, signal: request.signal });
      } catch {
        continue;
      }
      const perFile = new Map<string, number>();
      // A plain word such as "multiply" may still be the name of a function.
      const definition = definitionPattern(term, weight < 9);
      for (const match of result.matches) {
        const count = (perFile.get(match.path) ?? 0) + 1;
        perFile.set(match.path, count);
        if (definition?.test(match.text)) bump(match.path, 60, `defines "${term}"`, match.line);
        else if (count <= 5) bump(match.path, weight, `mentions "${term}"`, match.line);
      }
      // A term found in very many files says little about any one of them.
      if (perFile.size > 25) for (const path of perFile.keys()) bump(path, -weight * Math.min(perFile.get(path) ?? 0, 5) * 0.6, '');
    }
  }

  // 5. What is open in the editor.
  if (request.activeFile && index.has(request.activeFile)) bump(request.activeFile, 25, 'open in the editor');
  for (const open of request.openFiles ?? []) {
    if (open !== request.activeFile && index.has(open) && ranked.has(open)) bump(open, 10, 'open in a tab');
  }

  // 6. Tests that belong to the strongest source files (and the reverse).
  const leaders = [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  for (const leader of leaders) {
    if (leader.score < MIN_SCORE) continue;
    const leaderStem = stem(leader.path);
    if (!leaderStem) continue;
    const leaderIsTest = isTestFile(leader.path);
    for (const file of files) {
      if (file.path === leader.path || stem(file.path) !== leaderStem) continue;
      if (isTestFile(file.path) !== leaderIsTest) {
        bump(file.path, mentionsTests ? 55 : 14, leaderIsTest ? `source for ${baseName(leader.path)}` : `test for ${baseName(leader.path)}`);
      }
    }
  }

  return [...ranked.values()]
    .map((entry) => (entry.pinned ? entry : { ...entry, score: entry.score * qualityFactor(entry.path, request.prompt) }))
    .filter((entry) => entry.pinned || (entry.score >= MIN_SCORE && entry.reasons.length > 0 && index.has(entry.path)))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
