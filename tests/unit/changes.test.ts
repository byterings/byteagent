import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyChangeSet, NodeChangeIO } from '../../src/changes/applier';
import { buildChangeSet, countDiff, MAX_FILES_PER_CHANGE_SET } from '../../src/changes/proposal';
import type { ChangeIO, ChangeOperation, ChangeSet, ReviewDecision } from '../../src/changes/types';
import type { WorkspaceIndex } from '../../src/context/workspaceIndex';
import { ByteAgentError } from '../../src/shared/errors';
import { ABSENT_HASH, sha256 } from '../../src/shared/hash';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace;
let index: WorkspaceIndex;
afterEach(() => ws?.dispose());

function setup(files: Record<string, string> = sampleProject()): void {
  ws = tempWorkspace(files);
  index = ws.index();
}

const read = (rel: string): string => readFileSync(join(ws.root, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(join(ws.root, rel));

async function problem(ops: ChangeOperation[]): Promise<string> {
  try {
    await buildChangeSet(index, ops, 's');
  } catch (err) {
    expect(err).toBeInstanceOf(ByteAgentError);
    return (err as ByteAgentError).message;
  }
  throw new Error('expected the proposal to be refused');
}

const acceptAll = (set: ChangeSet): ReviewDecision => ({ decisions: Object.fromEntries(set.changes.map((c) => [c.id, 'accept' as const])) });

describe('buildChangeSet', () => {
  it('normalises a search-and-replace edit into full new content with a base hash', async () => {
    setup();
    const before = read('src/services/tax.ts');
    const set = await buildChangeSet(index, [{ type: 'edit', path: 'src/services/tax.ts', edits: [{ search: '0.2', replace: '0.25' }] }], 'Raise tax');
    expect(set.summary).toBe('Raise tax');
    expect(set.changes).toHaveLength(1);
    expect(set.changes[0]).toMatchObject({
      path: 'src/services/tax.ts',
      kind: 'modify',
      baseHash: sha256(before),
      baseContent: before,
      newContent: 'export const TAX_RATE = 0.25;\n',
      added: 1,
      removed: 1,
    });
    // Building a proposal never touches the file.
    expect(read('src/services/tax.ts')).toBe(before);
  });

  it('creates new files and marks deletions', async () => {
    setup();
    const set = await buildChangeSet(
      index,
      [
        { type: 'write', path: 'src/new/feature.ts', content: 'export const a = 1;\nexport const b = 2;\n' },
        { type: 'delete', path: 'src/services/email.ts' },
        { type: 'write', path: 'src/services/tax.ts', content: 'export const TAX_RATE = 0.1;\n' },
      ],
      '',
    );
    expect(set.changes.map((c) => [c.kind, c.path])).toEqual([
      ['modify', 'src/services/tax.ts'],
      ['create', 'src/new/feature.ts'],
      ['delete', 'src/services/email.ts'],
    ]);
    const created = set.changes[1]!;
    expect(created).toMatchObject({ baseHash: ABSENT_HASH, baseContent: null, added: 2, removed: 0 });
    const deleted = set.changes[2]!;
    expect(deleted.newContent).toBeNull();
    expect(deleted.removed).toBe(3);
    expect(exists('src/new/feature.ts')).toBe(false);
    expect(exists('src/services/email.ts')).toBe(true);
  });

  it('combines several operations on one file in order', async () => {
    setup();
    const set = await buildChangeSet(
      index,
      [
        { type: 'edit', path: 'src/services/tax.ts', edits: [{ search: 'TAX_RATE', replace: 'VAT_RATE' }] },
        { type: 'edit', path: './src/services/tax.ts', edits: [{ search: '0.2', replace: '0.3' }] },
      ],
      '',
    );
    expect(set.changes).toHaveLength(1);
    expect(set.changes[0]?.newContent).toBe('export const VAT_RATE = 0.3;\n');
  });

  it('refuses an edit whose search text is missing or ambiguous', async () => {
    setup({ 'a.txt': 'one\ntwo\none\n' });
    expect(await problem([{ type: 'edit', path: 'a.txt', edits: [{ search: 'three', replace: 'x' }] }])).toMatch(/was not found/);
    expect(await problem([{ type: 'edit', path: 'a.txt', edits: [{ search: 'one', replace: 'x' }] }])).toMatch(/matches 2 places/);
    expect(await problem([{ type: 'edit', path: 'a.txt', edits: [{ search: '', replace: 'x' }] }])).toMatch(/empty "search"/);
    expect(await problem([{ type: 'edit', path: 'a.txt', edits: [] }])).toMatch(/at least one edit/);
  });

  it('replaces every occurrence only when asked', async () => {
    setup({ 'a.txt': 'one\ntwo\none\n' });
    const set = await buildChangeSet(index, [{ type: 'edit', path: 'a.txt', edits: [{ search: 'one', replace: '1', replaceAll: true }] }], '');
    expect(set.changes[0]?.newContent).toBe('1\ntwo\n1\n');
  });

  it('inserts replacement text literally, including $ patterns', async () => {
    setup({ 'a.txt': 'price = COST;\n' });
    const set = await buildChangeSet(index, [{ type: 'edit', path: 'a.txt', edits: [{ search: 'COST', replace: "$& $1 $$ $'" }] }], '');
    expect(set.changes[0]?.newContent).toBe("price = $& $1 $$ $';\n");
  });

  it('matches LF search text against a CRLF file and keeps CRLF', async () => {
    setup({ 'win.txt': 'first\r\nsecond\r\nthird\r\n' });
    const set = await buildChangeSet(index, [{ type: 'edit', path: 'win.txt', edits: [{ search: 'first\nsecond', replace: 'one\ntwo' }] }], '');
    expect(set.changes[0]?.newContent).toBe('one\r\ntwo\r\nthird\r\n');
  });

  it('refuses paths outside the workspace and blocked files', async () => {
    setup();
    expect(await problem([{ type: 'write', path: '../evil.txt', content: 'x' }])).toMatch(/outside the workspace/);
    expect(await problem([{ type: 'write', path: '/etc/cron.d/evil', content: 'x' }])).toMatch(/outside the workspace/);
    expect(await problem([{ type: 'write', path: '.env', content: 'x' }])).toMatch(/sensitive file/);
    expect(await problem([{ type: 'edit', path: '.env', edits: [{ search: 'a', replace: 'b' }] }])).toMatch(/sensitive file/);
    expect(await problem([{ type: 'write', path: 'new/.env.production', content: 'x' }])).toMatch(/sensitive file/);
    expect(await problem([{ type: 'write', path: 'node_modules/x/index.js', content: 'x' }])).toMatch(/dependency or cache folder/);
    expect(await problem([{ type: 'write', path: '.git/hooks/pre-commit', content: 'x' }])).toMatch(/version control/);
    expect(await problem([{ type: 'delete', path: 'dist/app.js' }])).toMatch(/ignored by \.gitignore/);
  });

  it('refuses the whole proposal when any part is invalid', async () => {
    setup();
    const message = await problem([
      { type: 'edit', path: 'src/services/tax.ts', edits: [{ search: '0.2', replace: '0.3' }] },
      { type: 'write', path: '../evil.txt', content: 'x' },
      { type: 'delete', path: 'src/nope.ts' },
    ]);
    expect(message).toMatch(/not shown to the user because of problems/);
    expect(message).toMatch(/outside the workspace/);
    expect(message).toMatch(/cannot be deleted/);
  });

  it('refuses editing a missing file, writing over a folder, and malformed operations', async () => {
    setup();
    expect(await problem([{ type: 'edit', path: 'src/nope.ts', edits: [{ search: 'a', replace: 'b' }] }])).toMatch(/does not exist/);
    expect(await problem([{ type: 'write', path: 'src/services', content: 'x' }])).toMatch(/is a folder/);
    expect(await problem([{ type: 'rename', path: 'a' } as unknown as ChangeOperation])).toMatch(/Unknown change type/);
    expect(await problem([{ type: 'write', path: 'a.txt', content: 5 } as unknown as ChangeOperation])).toMatch(/must be text/);
    expect(await problem([null as unknown as ChangeOperation])).toMatch(/needs a "path"/);
    expect(await problem([])).toMatch(/No changes were given/);
  });

  it('refuses a proposal that changes nothing or is too large', async () => {
    setup({ 'a.txt': 'same\n' });
    expect(await problem([{ type: 'write', path: 'a.txt', content: 'same\n' }])).toMatch(/exactly as it is/);
    const many: ChangeOperation[] = Array.from({ length: MAX_FILES_PER_CHANGE_SET + 1 }, (_, i) => ({ type: 'write', path: `f${i}.txt`, content: 'x' }));
    expect(await problem(many)).toMatch(/at most/);
    expect(await problem([{ type: 'write', path: 'big.txt', content: 'x'.repeat(1024 * 1024 + 1) }])).toMatch(/over 1 MB/);
  });

  it('bases the change on unsaved editor text when there is some', async () => {
    ws = tempWorkspace({ 'a.txt': 'disk version\n' });
    index = ws.index({ overlay: (p) => (p === 'a.txt' ? 'editor version\n' : undefined) });
    const set = await buildChangeSet(index, [{ type: 'edit', path: 'a.txt', edits: [{ search: 'editor', replace: 'updated' }] }], '');
    expect(set.changes[0]).toMatchObject({ baseContent: 'editor version\n', baseHash: sha256('editor version\n'), newContent: 'updated version\n' });
  });
});

describe('countDiff', () => {
  it('counts added and removed lines', () => {
    expect(countDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(countDiff('', 'x\ny\n')).toEqual({ added: 2, removed: 0 });
    expect(countDiff('x\n', '')).toEqual({ added: 0, removed: 1 });
  });
});

describe('applyChangeSet', () => {
  const ops: ChangeOperation[] = [
    { type: 'edit', path: 'src/services/tax.ts', edits: [{ search: '0.2', replace: '0.25' }] },
    { type: 'write', path: 'src/new/feature.ts', content: 'export const feature = true;\n' },
    { type: 'delete', path: 'src/services/email.ts' },
  ];

  it('applies exactly the approved content when everything is accepted', async () => {
    setup();
    const set = await buildChangeSet(index, ops, '');
    const results = await applyChangeSet(index, set, acceptAll(set), new NodeChangeIO(ws.root));
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    expect(read('src/services/tax.ts')).toBe('export const TAX_RATE = 0.25;\n');
    expect(read('src/new/feature.ts')).toBe('export const feature = true;\n');
    expect(exists('src/services/email.ts')).toBe(false);
    // The index sees the result immediately.
    expect((await index.readText('src/services/tax.ts')).text).toContain('0.25');
    expect(index.has('src/new/feature.ts')).toBe(true);
    expect(index.has('src/services/email.ts')).toBe(false);
  });

  it('applies nothing when everything is rejected (Scenario F)', async () => {
    setup();
    const before = read('src/services/tax.ts');
    const set = await buildChangeSet(index, ops, '');
    const results = await applyChangeSet(index, set, { decisions: Object.fromEntries(set.changes.map((c) => [c.id, 'reject' as const])) }, new NodeChangeIO(ws.root));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(read('src/services/tax.ts')).toBe(before);
    expect(exists('src/new/feature.ts')).toBe(false);
    expect(exists('src/services/email.ts')).toBe(true);
  });

  it('treats a missing or unknown decision as a rejection', async () => {
    setup();
    const set = await buildChangeSet(index, ops, '');
    const results = await applyChangeSet(index, set, { decisions: { [set.changes[0]!.id]: 'maybe' as unknown as 'accept' } }, new NodeChangeIO(ws.root));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(read('src/services/tax.ts')).toContain('0.2;');
  });

  it('applies only the accepted files of a mixed review', async () => {
    setup();
    const set = await buildChangeSet(index, ops, '');
    const [tax, feature, email] = set.changes;
    const results = await applyChangeSet(index, set, { decisions: { [tax!.id]: 'accept', [feature!.id]: 'reject', [email!.id]: 'reject' } }, new NodeChangeIO(ws.root));
    expect(results.map((r) => r.status)).toEqual(['applied', 'rejected', 'rejected']);
    expect(read('src/services/tax.ts')).toContain('0.25');
    expect(exists('src/new/feature.ts')).toBe(false);
    expect(exists('src/services/email.ts')).toBe(true);
  });

  it('does not overwrite a file that changed after the preview (Scenario G)', async () => {
    setup();
    const set = await buildChangeSet(index, ops, '');
    ws.write('src/services/tax.ts', 'export const TAX_RATE = 0.19; // edited by someone else\n');
    const results = await applyChangeSet(index, set, acceptAll(set), new NodeChangeIO(ws.root));
    expect(results[0]).toMatchObject({ path: 'src/services/tax.ts', status: 'stale' });
    expect(results[0]?.error).toMatch(/changed after this preview/);
    expect(read('src/services/tax.ts')).toBe('export const TAX_RATE = 0.19; // edited by someone else\n');
    // The other files were still fine.
    expect(results.slice(1).map((r) => r.status)).toEqual(['applied', 'applied']);
  });

  it('detects a stale preview through unsaved editor changes', async () => {
    let unsaved: string | undefined;
    ws = tempWorkspace({ 'a.txt': 'original\n' });
    index = ws.index({ overlay: (p) => (p === 'a.txt' ? unsaved : undefined) });
    const set = await buildChangeSet(index, [{ type: 'write', path: 'a.txt', content: 'proposed\n' }], '');
    unsaved = 'typed in the editor, not saved\n';
    const results = await applyChangeSet(index, set, acceptAll(set), new NodeChangeIO(ws.root));
    expect(results[0]?.status).toBe('stale');
    expect(read('a.txt')).toBe('original\n');
  });

  it('does not overwrite a file that appeared where a new file was proposed', async () => {
    setup();
    const set = await buildChangeSet(index, [{ type: 'write', path: 'src/new.ts', content: 'mine\n' }], '');
    ws.write('src/new.ts', 'someone else created this\n');
    const results = await applyChangeSet(index, set, acceptAll(set), new NodeChangeIO(ws.root));
    expect(results[0]).toMatchObject({ status: 'stale' });
    expect(results[0]?.error).toMatch(/now exists/);
    expect(read('src/new.ts')).toBe('someone else created this\n');
  });

  it('reports a deletion as stale when the file changed or disappeared', async () => {
    setup();
    const set = await buildChangeSet(index, [{ type: 'delete', path: 'src/services/email.ts' }], '');
    ws.write('src/services/email.ts', '// now important\n');
    expect((await applyChangeSet(index, set, acceptAll(set), new NodeChangeIO(ws.root)))[0]?.status).toBe('stale');
    expect(exists('src/services/email.ts')).toBe(true);
  });

  it('reports partial failures per file and never claims a failed file was applied', async () => {
    setup();
    const set = await buildChangeSet(index, ops, '');
    const real = new NodeChangeIO(ws.root);
    const flaky: ChangeIO = {
      write: async (p, content) => {
        if (p === 'src/new/feature.ts') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        await real.write(p, content);
      },
      delete: (p) => real.delete(p),
    };
    const results = await applyChangeSet(index, set, acceptAll(set), flaky);
    expect(results.map((r) => [r.path, r.status])).toEqual([
      ['src/services/tax.ts', 'applied'],
      ['src/new/feature.ts', 'failed'],
      ['src/services/email.ts', 'applied'],
    ]);
    expect(results[1]?.error).toBe('Permission denied.');
    expect(exists('src/new/feature.ts')).toBe(false);
  });

  it('fails a change when the written content does not match what was approved', async () => {
    setup();
    const set = await buildChangeSet(index, [{ type: 'write', path: 'src/x.ts', content: 'approved\n' }], '');
    const real = new NodeChangeIO(ws.root);
    const tampering: ChangeIO = { write: (p) => real.write(p, 'something else\n'), delete: (p) => real.delete(p) };
    const results = await applyChangeSet(index, set, acceptAll(set), tampering);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toMatch(/does not match the approved content/);
  });

  it('re-checks the exclusion rules at apply time', async () => {
    setup();
    const set = await buildChangeSet(index, [{ type: 'write', path: 'notes/plan.txt', content: 'x\n' }], '');
    ws.write('.gitignore', 'node_modules/\ndist/\n*.log\nnotes/\n');
    index.policy.reset();
    const results = await applyChangeSet(index, set, acceptAll(set), new NodeChangeIO(ws.root));
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toMatch(/ignored by \.gitignore/);
    expect(exists('notes/plan.txt')).toBe(false);
  });

  it('keeps the file mode and leaves no temporary files behind', async () => {
    setup({ 'run.sh': '#!/bin/sh\necho old\n' });
    const { chmodSync, readdirSync } = await import('node:fs');
    chmodSync(join(ws.root, 'run.sh'), 0o755);
    const set = await buildChangeSet(index, [{ type: 'edit', path: 'run.sh', edits: [{ search: 'old', replace: 'new' }] }], '');
    await applyChangeSet(index, set, acceptAll(set), new NodeChangeIO(ws.root));
    expect(statSync(join(ws.root, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(readdirSync(ws.root)).toEqual(['run.sh']);
  });
});
