import type { WorkspaceIndex } from './workspaceIndex';

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'constant' | 'method' | 'struct' | 'trait' | 'module';
  /** 1-based line of the declaration. */
  line: number;
}

export interface SymbolMatch extends SymbolEntry {
  path: string;
}

type Rule = [RegExp, SymbolEntry['kind']];

const JS_RULES: Rule[] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
  [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, 'type'],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
  [/^(?:export\s+)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'constant'],
  [/^(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=/, 'constant'],
  [/^\s{2,}(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]+)?\{/, 'method'],
];

const PY_RULES: Rule[] = [
  [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
  [/^class\s+([A-Za-z_]\w*)/, 'class'],
  [/^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'method'],
  [/^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, 'constant'],
];

const GO_RULES: Rule[] = [
  [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'],
  [/^type\s+([A-Za-z_]\w*)\s+struct\b/, 'struct'],
  [/^type\s+([A-Za-z_]\w*)\s+interface\b/, 'interface'],
  [/^type\s+([A-Za-z_]\w*)\s+/, 'type'],
  [/^(?:const|var)\s+([A-Za-z_]\w*)/, 'constant'],
];

const RUST_RULES: Rule[] = [
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, 'struct'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, 'enum'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, 'trait'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, 'type'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, 'module'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_][A-Z0-9_]*)/, 'constant'],
];

const JVM_RULES: Rule[] = [
  [/^\s*(?:(?:public|private|protected|internal|abstract|final|sealed|static|data|open|partial)\s+)*(?:class|record|object)\s+([A-Za-z_]\w*)/, 'class'],
  [/^\s*(?:(?:public|private|protected|internal|sealed)\s+)*interface\s+([A-Za-z_]\w*)/, 'interface'],
  [/^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+(?:class\s+)?([A-Za-z_]\w*)/, 'enum'],
  [/^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/, 'function'],
  [/^\s+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|virtual|override|async)\s+)+[\w<>\[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\{/, 'method'],
];

const RUBY_RULES: Rule[] = [
  [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, 'function'],
  [/^\s*class\s+([A-Z]\w*)/, 'class'],
  [/^\s*module\s+([A-Z]\w*)/, 'module'],
];

const PHP_RULES: Rule[] = [
  [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)/, 'function'],
  [/^\s*(?:(?:final|abstract)\s+)*class\s+([A-Za-z_]\w*)/, 'class'],
  [/^\s*interface\s+([A-Za-z_]\w*)/, 'interface'],
  [/^\s*trait\s+([A-Za-z_]\w*)/, 'trait'],
];

const C_RULES: Rule[] = [
  [/^\s*(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/, 'class'],
  [/^\s*enum\s+(?:class\s+)?([A-Za-z_]\w*)/, 'enum'],
  [/^(?:[A-Za-z_][\w:<>*&\s]*?)\s+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/, 'function'],
  [/^#define\s+([A-Z_][A-Z0-9_]{2,})/, 'constant'],
];

const RULES_BY_EXT: Record<string, Rule[]> = {
  ts: JS_RULES, tsx: JS_RULES, mts: JS_RULES, cts: JS_RULES, js: JS_RULES, jsx: JS_RULES, mjs: JS_RULES, cjs: JS_RULES, vue: JS_RULES, svelte: JS_RULES,
  py: PY_RULES,
  go: GO_RULES,
  rs: RUST_RULES,
  java: JVM_RULES, kt: JVM_RULES, kts: JVM_RULES, cs: JVM_RULES, scala: JVM_RULES, swift: JVM_RULES, dart: JVM_RULES,
  rb: RUBY_RULES,
  php: PHP_RULES,
  c: C_RULES, h: C_RULES, cpp: C_RULES, cc: C_RULES, hpp: C_RULES,
};

const NOT_SYMBOLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do', 'try', 'new', 'await', 'typeof', 'super', 'this', 'get', 'set', 'main']);
const MAX_SYMBOLS_PER_FILE = 400;
const MAX_LINE_LENGTH = 400;

export function supportsSymbols(ext: string): boolean {
  return ext in RULES_BY_EXT;
}

/**
 * Finds declarations with line-based patterns. This is deliberately not a
 * parser: it is fast, needs no per-language dependency, and is good enough
 * to answer "which file defines this name".
 */
export function extractSymbols(text: string, ext: string): SymbolEntry[] {
  const rules = RULES_BY_EXT[ext];
  if (!rules) return [];
  const symbols: SymbolEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; i++) {
    const line = lines[i] as string;
    if (line.length > MAX_LINE_LENGTH || line.trim() === '') continue;
    for (const [pattern, kind] of rules) {
      const match = pattern.exec(line);
      const name = match?.[1];
      if (!name || NOT_SYMBOLS.has(name)) continue;
      symbols.push({ name, kind, line: i + 1 });
      break;
    }
  }
  return symbols;
}

/** "getUserProfile", "get_user_profile" and "Get User Profile" all become "getuserprofile". */
export function normalizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

interface FileSymbols {
  size: number;
  mtimeMs: number;
  symbols: SymbolEntry[];
}

export interface SymbolIndexStats {
  files: number;
  symbols: number;
  /** Files whose symbols were re-read in the last update. */
  reparsed: number;
  durationMs: number;
}

const MAX_SYMBOL_FILES = 8000;
const MAX_SYMBOL_FILE_BYTES = 300 * 1024;

/**
 * Names declared in the workspace, by file. Updated incrementally: a file
 * is parsed again only when its size or modification time changed.
 */
export class SymbolIndex {
  private readonly byFile = new Map<string, FileSymbols>();
  private byName = new Map<string, SymbolMatch[]>();
  private built = false;
  lastStats: SymbolIndexStats | undefined;

  constructor(private readonly index: WorkspaceIndex) {}

  /** Brings the symbol table in step with the file list. */
  async update(): Promise<SymbolIndexStats> {
    const started = Date.now();
    await this.index.ensureFresh();
    const files = this.index
      .textFiles()
      .filter((f) => supportsSymbols(f.ext) && f.size <= MAX_SYMBOL_FILE_BYTES)
      .slice(0, MAX_SYMBOL_FILES);
    const present = new Set<string>();
    let reparsed = 0;
    let changed = !this.built;

    for (const file of files) {
      present.add(file.path);
      const known = this.byFile.get(file.path);
      if (known && known.size === file.size && known.mtimeMs === file.mtimeMs) continue;
      let symbols: SymbolEntry[] = [];
      try {
        symbols = extractSymbols((await this.index.readText(file.path)).text, file.ext);
      } catch {
        // unreadable right now; it simply has no symbols
      }
      this.byFile.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, symbols });
      reparsed += 1;
      changed = true;
    }
    for (const path of [...this.byFile.keys()]) {
      if (!present.has(path)) {
        this.byFile.delete(path);
        changed = true;
      }
    }

    if (changed) {
      const byName = new Map<string, SymbolMatch[]>();
      for (const [path, entry] of this.byFile) {
        for (const symbol of entry.symbols) {
          const key = normalizeName(symbol.name);
          if (!key) continue;
          const list = byName.get(key);
          if (list) list.push({ ...symbol, path });
          else byName.set(key, [{ ...symbol, path }]);
        }
      }
      this.byName = byName;
    }
    this.built = true;
    let total = 0;
    for (const entry of this.byFile.values()) total += entry.symbols.length;
    this.lastStats = { files: this.byFile.size, symbols: total, reparsed, durationMs: Date.now() - started };
    return this.lastStats;
  }

  /** Declarations whose name equals the given text, ignoring case and separators. */
  find(name: string): SymbolMatch[] {
    return this.byName.get(normalizeName(name)) ?? [];
  }

  /** Declarations whose name contains the given text (at least 6 characters). */
  findContaining(fragment: string, limit = 20): SymbolMatch[] {
    const key = normalizeName(fragment);
    if (key.length < 6) return [];
    const out: SymbolMatch[] = [];
    for (const [name, matches] of this.byName) {
      if (name !== key && name.includes(key)) {
        out.push(...matches);
        if (out.length >= limit) break;
      }
    }
    return out.slice(0, limit);
  }

  symbolsOf(path: string): SymbolEntry[] {
    return this.byFile.get(path)?.symbols ?? [];
  }

  /** Per-file symbols, for saving to the project database. */
  entries(): Array<{ path: string; symbols: SymbolEntry[] }> {
    return [...this.byFile.entries()].map(([path, entry]) => ({ path, symbols: entry.symbols }));
  }
}
