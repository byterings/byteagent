import { afterEach, describe, expect, it } from 'vitest';
import { buildContext, computeContextBudget, MODE_LIMITS } from '../../src/context/contextBuilder';
import { extractTerms, rankFiles } from '../../src/context/ranker';
import { detectProject, summarizeFacts } from '../../src/context/techDetect';
import type { Attachment } from '../../src/shared/protocol';
import { estimateTokens, truncateToTokens } from '../../src/shared/tokens';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace | undefined;
afterEach(() => {
  ws?.dispose();
  ws = undefined;
});

describe('extractTerms', () => {
  it('separates identifiers, plain words and paths', () => {
    const terms = extractTerms('Why does orderTotal in src/services/pricing.ts return the wrong coupon discount? See `roundCents` and tax.ts:12');
    expect(terms.strong).toEqual(expect.arrayContaining(['orderTotal', 'roundCents']));
    expect(terms.paths).toEqual(expect.arrayContaining(['src/services/pricing.ts', 'tax.ts']));
    expect(terms.weak).toEqual(expect.arrayContaining(['coupon', 'discount']));
    expect(terms.weak).not.toContain('the');
    expect(terms.weak).not.toContain('does');
  });
  it('handles snake_case and returns nothing for filler text', () => {
    expect(extractTerms('fix get_user_profile').strong).toContain('get_user_profile');
    expect(extractTerms('can you help me with this please')).toEqual({ strong: [], weak: [], paths: [], parts: [] });
  });
  it('does not treat version numbers as files', () => {
    expect(extractTerms('upgrade to 2.5 and node 20.1').paths).toEqual([]);
  });
});

describe('rankFiles', () => {
  const base: { attachments: Attachment[]; contentSearch: boolean } = { attachments: [], contentSearch: true };

  it('puts the defining file first for an identifier', async () => {
    ws = tempWorkspace(sampleProject());
    const ranked = await rankFiles(ws.index(), { ...base, prompt: 'What does orderTotal do?' });
    expect(ranked[0]?.path).toBe('src/services/pricing.ts');
    expect(ranked[0]?.reasons.join(' ')).toContain('orderTotal');
    expect(ranked[0]?.matchLines.length).toBeGreaterThan(0);
  });

  it('does not include unrelated files', async () => {
    ws = tempWorkspace(sampleProject());
    const ranked = await rankFiles(ws.index(), { ...base, prompt: 'What does orderTotal do?' });
    const paths = ranked.map((r) => r.path);
    expect(paths).not.toContain('src/utils/strings.ts');
    expect(paths).not.toContain('src/services/email.ts');
    for (const r of ranked) expect(r.reasons.length, r.path).toBeGreaterThan(0);
  });

  it('returns nothing when the request has no usable terms', async () => {
    ws = tempWorkspace(sampleProject());
    expect(await rankFiles(ws.index(), { ...base, prompt: 'hello, can you help me?' })).toEqual([]);
  });

  it('always ranks attachments first and keeps their line range', async () => {
    ws = tempWorkspace(sampleProject());
    const ranked = await rankFiles(ws.index(), {
      ...base,
      prompt: 'What does orderTotal do?',
      attachments: [{ path: 'src/utils/strings.ts', startLine: 1, endLine: 2, source: 'selection' }],
    });
    expect(ranked[0]).toMatchObject({ path: 'src/utils/strings.ts', pinned: true, startLine: 1, endLine: 2 });
    expect(ranked[0]?.reasons).toContain('your selection');
  });

  it('finds a file named in the request', async () => {
    ws = tempWorkspace(sampleProject());
    const ranked = await rankFiles(ws.index(), { ...base, prompt: 'open tax.ts and raise the rate' });
    expect(ranked[0]?.path).toBe('src/services/tax.ts');
    expect(ranked[0]?.reasons).toContain('named in your request');
  });

  it('pairs tests with their source, more strongly when tests are mentioned', async () => {
    ws = tempWorkspace(sampleProject());
    const plain = await rankFiles(ws.index(), { ...base, prompt: 'change roundCents', contentSearch: false, attachments: [{ path: 'src/services/pricing.ts', source: 'mention' }] });
    const withTests = await rankFiles(ws.index(), { ...base, prompt: 'change roundCents and update the tests', contentSearch: false, attachments: [{ path: 'src/services/pricing.ts', source: 'mention' }] });
    const scoreOf = (list: typeof plain) => list.find((r) => r.path === 'tests/services/pricing.test.ts')?.score ?? 0;
    expect(scoreOf(withTests)).toBeGreaterThan(scoreOf(plain));
    expect(withTests.map((r) => r.path)).toContain('tests/services/pricing.test.ts');
  });

  it('boosts the active editor file only together with other evidence or on its own merit', async () => {
    ws = tempWorkspace(sampleProject());
    const ranked = await rankFiles(ws.index(), { ...base, prompt: 'explain orderTotal', activeFile: 'src/routes/orders.ts' });
    const orders = ranked.find((r) => r.path === 'src/routes/orders.ts');
    expect(orders?.reasons).toContain('open in the editor');
  });

  it('never ranks blocked files, even when named', async () => {
    ws = tempWorkspace(sampleProject());
    const ranked = await rankFiles(ws.index(), { ...base, prompt: 'show me .env and config/secrets.yaml and API_SECRET' });
    const paths = ranked.map((r) => r.path);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('config/secrets.yaml');
  });
});

describe('buildContext', () => {
  const request: { attachments: Attachment[]; mode: 'standard'; budgetTokens: number } = { attachments: [], mode: 'standard', budgetTokens: 8000 };

  it('selects relevant files within the budget and explains each one', async () => {
    ws = tempWorkspace(sampleProject());
    const pkg = await buildContext(ws.index(), { ...request, prompt: 'Fix the coupon handling in orderTotal' });
    expect(pkg.files[0]?.path).toBe('src/services/pricing.ts');
    expect(pkg.files.length).toBeLessThanOrEqual(MODE_LIMITS.standard.maxFiles);
    expect(pkg.totalTokens).toBeLessThanOrEqual(pkg.budget);
    for (const f of pkg.files) expect(f.reason, f.path).not.toBe('');
    expect(pkg.rendered).toContain('<file path="src/services/pricing.ts">');
    expect(pkg.rendered).toContain('export function orderTotal');
    expect(pkg.files.map((f) => f.path)).not.toContain('src/utils/strings.ts');
  });

  it('never exceeds the budget and records what was left out', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`src/mod${i}.ts`] = `export function handlePayment${i}() {}\n${'// payment logic line\n'.repeat(120)}`;
    ws = tempWorkspace(files);
    const pkg = await buildContext(ws.index(), { ...request, prompt: 'review the payment logic everywhere', budgetTokens: 1500 });
    expect(pkg.totalTokens).toBeLessThanOrEqual(1500);
    expect(pkg.files.length).toBeGreaterThan(0);
    expect(pkg.omitted.length).toBeGreaterThan(0);
    expect(pkg.omitted.some((o) => /budget|relevance/.test(o.reason))).toBe(true);
    expect(pkg.files.some((f) => f.truncated)).toBe(true);
    expect(estimateTokens(pkg.rendered)).toBeLessThan(1500 * 1.15);
  });

  it('sends an empty package when the budget is zero', async () => {
    ws = tempWorkspace(sampleProject());
    const pkg = await buildContext(ws.index(), { ...request, prompt: 'Fix orderTotal', budgetTokens: 0 });
    expect(pkg.files).toEqual([]);
    expect(pkg.rendered).toBe('');
    expect(pkg.omitted.length).toBeGreaterThan(0);
  });

  it('includes only the selected lines of an attached selection', async () => {
    ws = tempWorkspace(sampleProject());
    const pkg = await buildContext(ws.index(), {
      ...request,
      prompt: 'explain this',
      attachments: [{ path: 'src/services/pricing.ts', startLine: 5, endLine: 9, source: 'selection' }],
    });
    const file = pkg.files[0];
    expect(file).toMatchObject({ path: 'src/services/pricing.ts', startLine: 5, endLine: 9, reason: 'your selection' });
    expect(file?.text.startsWith('export function orderTotal')).toBe(true);
    expect(file?.text).not.toContain('roundCents(value');
    expect(pkg.rendered).toContain('lines="5-9"');
  });

  it('reports attached files that are blocked instead of sending them', async () => {
    ws = tempWorkspace(sampleProject());
    const pkg = await buildContext(ws.index(), {
      ...request,
      prompt: 'what is in these',
      attachments: [
        { path: '.env', source: 'mention' },
        { path: 'node_modules/express/index.js', source: 'mention' },
        { path: '../outside.txt', source: 'mention' },
        { path: 'src/missing.ts', source: 'mention' },
        { path: 'src/services/tax.ts', source: 'mention' },
      ],
    });
    expect(pkg.files.map((f) => f.path)).toEqual(['src/services/tax.ts']);
    const reasons = Object.fromEntries(pkg.omitted.map((o) => [o.path, o.reason]));
    expect(reasons['.env']).toBe('sensitive file');
    expect(reasons['node_modules/express/index.js']).toBe('dependency or cache folder');
    expect(reasons['../outside.txt']).toBe('outside the workspace');
    expect(reasons['src/missing.ts']).toBe('file not found');
    expect(pkg.rendered).not.toContain('hunter2');
    expect(pkg.rendered).not.toContain('topsecretvalue123');
  });

  it('uses excerpts around matches for large files', async () => {
    const big = Array.from({ length: 900 }, (_, i) => (i === 600 ? 'export function computeShippingFee() { return 5; }' : `const filler${i} = ${i};`)).join('\n');
    ws = tempWorkspace({ 'src/shipping.ts': big, 'src/other.ts': 'export const x = 1;\n' });
    const pkg = await buildContext(ws.index(), { ...request, prompt: 'what does computeShippingFee return?', budgetTokens: 3000 });
    const file = pkg.files.find((f) => f.path === 'src/shipping.ts');
    expect(file?.truncated).toBe(true);
    expect(file?.text).toContain('computeShippingFee');
    expect(file?.text).toContain('[lines ');
    expect(file?.tokens).toBeLessThan(3000);
  });

  it('includes fewer files in quick mode than in project mode', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 14; i++) files[`src/invoice${i}.ts`] = `export function buildInvoice${i}() { return 'invoice'; }\n`;
    ws = tempWorkspace(files);
    const quick = await buildContext(ws.index(), { ...request, mode: 'quick', prompt: 'how are invoice files built?' });
    const project = await buildContext(ws.index(), { ...request, mode: 'project', prompt: 'how are invoice files built?' });
    expect(quick.files.length).toBe(MODE_LIMITS.quick.maxFiles);
    expect(project.files.length).toBeGreaterThan(quick.files.length);
    expect(quick.omitted.some((o) => o.reason === 'lower relevance')).toBe(true);
  });

  it('sees file changes made after an earlier build', async () => {
    ws = tempWorkspace(sampleProject());
    const index = ws.index();
    const first = await buildContext(index, { ...request, prompt: 'what is TAX_RATE in tax.ts' });
    expect(first.rendered).toContain('TAX_RATE = 0.2');
    ws.write('src/services/tax.ts', 'export const TAX_RATE = 0.25;\n');
    const second = await buildContext(index, { ...request, prompt: 'what is TAX_RATE in tax.ts' });
    expect(second.rendered).toContain('TAX_RATE = 0.25');
    expect(second.files.find((f) => f.path === 'src/services/tax.ts')?.hash).not.toBe(first.files.find((f) => f.path === 'src/services/tax.ts')?.hash);
  });
});

describe('computeContextBudget', () => {
  it('reserves output and safety margin, then caps by mode', () => {
    expect(computeContextBudget({ contextWindow: 128000, fixedTokens: 2000, mode: 'quick' })).toBe(6000);
    expect(computeContextBudget({ contextWindow: 128000, fixedTokens: 2000, mode: 'project' })).toBe(24000);
    const small = computeContextBudget({ contextWindow: 8000, fixedTokens: 1000, mode: 'standard' });
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(8000 - 2000 - 1000);
  });
  it('returns zero when nothing is left', () => {
    expect(computeContextBudget({ contextWindow: 4000, maxOutputTokens: 3500, fixedTokens: 600, mode: 'quick' })).toBe(0);
  });
  it('honours an explicit output reservation', () => {
    const a = computeContextBudget({ contextWindow: 16000, maxOutputTokens: 1000, fixedTokens: 0, mode: 'project' });
    const b = computeContextBudget({ contextWindow: 16000, maxOutputTokens: 8000, fixedTokens: 0, mode: 'project' });
    expect(a).toBeGreaterThan(b);
  });
});

describe('token estimates', () => {
  it('over-counts rather than under-counts', () => {
    const code = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
    expect(estimateTokens(code)).toBeGreaterThanOrEqual(Math.ceil(code.length / 4));
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('世界')).toBe(2);
  });
  it('truncates on a line boundary within the limit', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line number ${i}`).join('\n');
    const cut = truncateToTokens(text, 100);
    expect(cut.truncated).toBe(true);
    expect(estimateTokens(cut.text)).toBeLessThanOrEqual(100);
    expect(text.startsWith(cut.text)).toBe(true);
    expect(truncateToTokens('short', 100)).toEqual({ text: 'short', truncated: false });
  });
});

describe('detectProject', () => {
  it('reads the stack and commands from manifests', async () => {
    ws = tempWorkspace(sampleProject());
    const facts = await detectProject(ws.index());
    expect(facts.languages[0]?.name).toBe('TypeScript');
    expect(facts.frameworks).toEqual(expect.arrayContaining(['Express', 'Vitest']));
    expect(facts.packageManagers).toEqual(['npm']);
    expect(facts.testCommands).toEqual(['npm test']);
    expect(facts.buildCommands).toEqual(['npm run build']);
    expect(facts.lintCommands).toEqual(['npm run lint']);
    expect(facts.topLevel).toContain('src/');
    expect(facts.topLevel).not.toContain('node_modules/');
    expect(summarizeFacts(facts)).toContain('Test commands: npm test');
  });

  it('detects Python, Go and Make projects', async () => {
    ws = tempWorkspace({
      'requirements.txt': 'fastapi==0.1\npytest\n',
      'app/main.py': 'print(1)\n',
      'tests/test_main.py': 'def test_x(): pass\n',
      'go.mod': 'module x\n',
      'Makefile': 'build:\n\tgo build\ntest:\n\tgo test\n',
    });
    const facts = await detectProject(ws.index());
    expect(facts.frameworks).toEqual(expect.arrayContaining(['FastAPI', 'pytest']));
    expect(facts.testCommands).toEqual(expect.arrayContaining(['pytest', 'go test ./...', 'make test']));
    expect(facts.manifests).toEqual(expect.arrayContaining(['requirements.txt', 'go.mod', 'Makefile']));
  });

  it('ignores the default npm test placeholder and malformed manifests', async () => {
    ws = tempWorkspace({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' });
    expect((await detectProject(ws.index())).testCommands).toEqual([]);
    ws.write('package.json', '{not json');
    const facts = await detectProject(ws.index());
    expect(facts.manifests).toContain('package.json');
    expect(facts.frameworks).toEqual([]);
  });

  it('reports nothing for an empty folder', async () => {
    ws = tempWorkspace({});
    const facts = await detectProject(ws.index());
    expect(summarizeFacts(facts)).toBe('');
  });
});

describe('rankFiles with plain-word names', () => {
  it('finds the file that defines a function named with an ordinary word', async () => {
    ws = tempWorkspace({
      'src/math.js': 'function add(a, b) {\n  return a + b;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, multiply };\n',
      'src/greet.js': "function greet(name) {\n  return 'Hello ' + name;\n}\n",
      'notes.md': 'We should multiply our efforts.\n',
    });
    const ranked = await rankFiles(ws.index(), { prompt: 'What does the multiply function do?', attachments: [], contentSearch: true });
    expect(ranked[0]?.path).toBe('src/math.js');
    expect(ranked[0]?.reasons).toContain('defines "multiply"');
    expect(ranked.map((r) => r.path)).not.toContain('src/greet.js');
    expect(ranked.map((r) => r.path)).not.toContain('notes.md');
  });
});
