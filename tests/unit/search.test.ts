import { afterEach, describe, expect, it } from 'vitest';
import { findFiles, findRipgrep, searchText } from '../../src/context/search';
import { ByteAgentError } from '../../src/shared/errors';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace | undefined;
afterEach(() => {
  ws?.dispose();
  ws = undefined;
});

const rg = findRipgrep(['rg']);
const engines: Array<[string, string | undefined]> = [['scan', undefined]];
if (rg) engines.push(['ripgrep', rg]);

describe.each(engines)('searchText with %s', (engine, ripgrepPath) => {
  it('finds matches with path, line and text', async () => {
    ws = tempWorkspace(sampleProject());
    const result = await searchText(ws.index(), 'orderTotal', { ripgrepPath });
    expect(result.engine).toBe(engine);
    const paths = [...new Set(result.matches.map((m) => m.path))].sort();
    expect(paths).toEqual(['src/routes/orders.ts', 'src/services/pricing.ts', 'tests/services/pricing.test.ts']);
    const def = result.matches.find((m) => m.path === 'src/services/pricing.ts');
    expect(def).toMatchObject({ line: 5 });
    expect(def?.text).toContain('export function orderTotal');
  });

  it('never returns matches from sensitive, ignored or dependency files', async () => {
    ws = tempWorkspace(sampleProject());
    const index = ws.index();
    for (const secret of ['hunter2', 'topsecretvalue123', 'sk_live_abcdefghijklmnop', 'MIIabc']) {
      const result = await searchText(index, secret, { ripgrepPath });
      expect(result.matches, secret).toEqual([]);
    }
    const everywhere = await searchText(index, 'orderTotal', { ripgrepPath, maxResults: 500 });
    for (const m of everywhere.matches) {
      expect(m.path.startsWith('node_modules/') || m.path.startsWith('dist/') || m.path.endsWith('.log')).toBe(false);
    }
  });

  it('is case-insensitive by default and case-sensitive on request', async () => {
    ws = tempWorkspace({ 'a.txt': 'Hello World\nhello world\n' });
    const index = ws.index();
    expect((await searchText(index, 'HELLO', { ripgrepPath })).matches).toHaveLength(2);
    expect((await searchText(index, 'Hello', { ripgrepPath, caseSensitive: true })).matches).toHaveLength(1);
  });

  it('treats the query as literal text unless regex is requested', async () => {
    ws = tempWorkspace({ 'a.txt': 'price * qty\nfoo(bar)\nfoobar\n' });
    const index = ws.index();
    expect((await searchText(index, 'price * qty', { ripgrepPath })).matches).toHaveLength(1);
    expect((await searchText(index, 'foo(bar)', { ripgrepPath })).matches).toHaveLength(1);
    expect((await searchText(index, 'foo\\(?bar', { ripgrepPath, regex: true })).matches).toHaveLength(2);
  });

  it('rejects an invalid regular expression', async () => {
    ws = tempWorkspace({ 'a.txt': 'x' });
    await expect(searchText(ws.index(), '([unclosed', { ripgrepPath, regex: true })).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(searchText(ws.index(), '', { ripgrepPath })).rejects.toBeInstanceOf(ByteAgentError);
  });

  it('limits results and reports truncation', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.txt`] = 'needle\nneedle\nneedle\n';
    ws = tempWorkspace(files);
    const result = await searchText(ws.index(), 'needle', { ripgrepPath, maxResults: 10 });
    expect(result.matches).toHaveLength(10);
    expect(result.truncated).toBe(true);
    const perFile = await searchText(ws.index(), 'needle', { ripgrepPath, maxResults: 100, maxMatchesPerFile: 1 });
    expect(perFile.matches).toHaveLength(12);
  });

  it('restricts the search to a path prefix', async () => {
    ws = tempWorkspace(sampleProject());
    const result = await searchText(ws.index(), 'orderTotal', { ripgrepPath, pathPrefix: 'tests' });
    expect([...new Set(result.matches.map((m) => m.path))]).toEqual(['tests/services/pricing.test.ts']);
  });

  it('clips very long lines', async () => {
    ws = tempWorkspace({ 'a.txt': `needle ${'x'.repeat(1000)}\n` });
    const result = await searchText(ws.index(), 'needle', { ripgrepPath });
    expect(result.matches[0]?.text.length).toBeLessThan(260);
  });
});

describe('search engines', () => {
  it('falls back to scanning when the ripgrep path does not work', async () => {
    ws = tempWorkspace({ 'a.txt': 'needle\n' });
    const result = await searchText(ws.index(), 'needle', { ripgrepPath: '/nonexistent/rg-binary' });
    expect(result.engine).toBe('scan');
    expect(result.matches).toHaveLength(1);
  });

  it('stops when cancelled', async () => {
    ws = tempWorkspace({ 'a.txt': 'needle\n' });
    const controller = new AbortController();
    controller.abort();
    await expect(searchText(ws.index(), 'needle', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('probes ripgrep candidates', () => {
    expect(findRipgrep(['/nonexistent/rg-binary'])).toBeUndefined();
    if (rg) expect(findRipgrep(['/nonexistent/rg-binary', 'rg'])).toBe('rg');
  });
});

describe('findFiles', () => {
  it('ranks exact names over partial and fuzzy matches', async () => {
    ws = tempWorkspace(sampleProject());
    const index = ws.index();
    await index.refresh();
    expect(findFiles(index, 'pricing.ts')[0]).toBe('src/services/pricing.ts');
    expect(findFiles(index, 'pricing').slice(0, 2).sort()).toEqual(['src/services/pricing.ts', 'tests/services/pricing.test.ts']);
    expect(findFiles(index, 'routes/ord')[0]).toBe('src/routes/orders.ts');
    expect(findFiles(index, 'srvprc')).toContain('src/services/pricing.ts');
    expect(findFiles(index, 'zzzznotthere')).toEqual([]);
    expect(findFiles(index, '.env')).not.toContain('.env');
  });

  it('returns recent files for an empty query and respects the limit', async () => {
    ws = tempWorkspace(sampleProject());
    const index = ws.index();
    await index.refresh();
    expect(findFiles(index, '', 3)).toHaveLength(3);
  });
});
