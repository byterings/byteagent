import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

/** Files that are allowed to import the vscode module. */
const VSCODE_ALLOWED = [
  /^extension\.ts$/,
  /^commands\//,
  /^chat\//,
  /^shared\/vscodeLogger\.ts$/,
  /^config\/vscodeSettings\.ts$/,
  /^config\/secrets\.ts$/,
  /^changes\/vscodeReview\.ts$/,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const files = walk(SRC).map((full) => ({
  rel: relative(SRC, full).split('\\').join('/'),
  text: readFileSync(full, 'utf8'),
}));

function imports(text: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push((m[1] ?? m[2] ?? m[3]) as string);
  return out;
}

describe('module boundaries', () => {
  it('only adapter files import vscode', () => {
    const offenders = files
      .filter((f) => imports(f.text).includes('vscode'))
      .filter((f) => !VSCODE_ALLOWED.some((re) => re.test(f.rel)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('no source file imports a vendor AI SDK', () => {
    const vendor = /^(openai|@anthropic-ai\/|@google\/generative-ai|@google\/genai|cohere-ai|@mistralai\/|ollama|langchain|@langchain\/)/;
    const offenders = files.filter((f) => imports(f.text).some((i) => vendor.test(i))).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('nothing outside the adapters imports chat, commands or the extension entry', () => {
    const offenders = files
      .filter((f) => !/^(extension\.ts|commands\/|chat\/)/.test(f.rel))
      .filter((f) => imports(f.text).some((i) => /(^|\/)(chat|commands)(\/|$)|\/extension$/.test(i) && i.startsWith('.')))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('shared imports nothing from other modules, and providers import only shared', () => {
    const bad: string[] = [];
    for (const f of files) {
      const local = imports(f.text).filter((i) => i.startsWith('.'));
      if (f.rel.startsWith('shared/') && local.some((i) => i.startsWith('../'))) bad.push(f.rel);
      if (f.rel.startsWith('providers/') && local.some((i) => i.startsWith('../') && !i.startsWith('../shared/'))) {
        bad.push(f.rel);
      }
    }
    expect(bad).toEqual([]);
  });
});
