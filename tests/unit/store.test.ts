import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, newTask } from '../../src/agent/taskState';
import { ProjectStore } from '../../src/project/store';
import { newRunRecord } from '../../src/tools/types';

const wasmPath = join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
let dir: string;
let dbPath: string;
const open = (path = dbPath) => ProjectStore.open({ path, wasmPath });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'byteagent-store-'));
  dbPath = join(dir, '.byteagent', 'agent.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sampleTask() {
  const task = applyPlanUpdate(newTask({ goal: 'Add authentication\nacross the API', mode: 'project', sessionId: 's1' }, 1000), {
    criteria: ['Login works', 'Tests pass'],
    steps: [{ title: 'Inspect', status: 'done' }, { title: 'Build', status: 'in_progress' }],
  }).task;
  return { ...task, files: { 'src/auth.ts': 'hash1' }, notes: ['Files changed: src/auth.ts'] };
}

describe('ProjectStore', () => {
  it('creates the database file and its folder on first save', async () => {
    const store = await open();
    expect(existsSync(dbPath)).toBe(false);
    store.save(sampleTask());
    await store.flush();
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(dbPath).subarray(0, 15).toString()).toBe('SQLite format 3');
    await store.dispose();
  });

  it('keeps tasks exactly across a restart', async () => {
    const first = await open();
    const task = sampleTask();
    first.save(task);
    await first.dispose();

    const second = await open();
    expect(second.get(task.id)).toEqual(task);
    expect(second.list()).toEqual([task]);
    await second.dispose();
  });

  it('updates an existing task and lists newest first', async () => {
    const store = await open();
    const a = sampleTask();
    const b = { ...newTask({ goal: 'Second task', mode: 'project' as const }, 5000) };
    store.save(a);
    store.save(b);
    store.save({ ...a, status: 'paused', updatedAt: 9000, steps: a.steps.map((s) => ({ ...s, status: 'done' as const })) });
    expect(store.list().map((t) => t.id)).toEqual([a.id, b.id]);
    expect(store.get(a.id)).toMatchObject({ status: 'paused', updatedAt: 9000 });
    expect(store.get(a.id)?.steps.every((s) => s.status === 'done')).toBe(true);
    expect(store.get('missing')).toBeUndefined();
    await store.dispose();
  });

  it('records what a run did as events and command evidence', async () => {
    const store = await open();
    const record = newRunRecord();
    record.applied.push('src/a.ts', 'src/a.ts');
    record.rejected.push('src/b.ts');
    record.failed.push({ path: 'src/c.ts', error: 'Permission denied.' });
    record.commands.push(
      { command: 'npm test', exitCode: 1, durationMs: 1200, status: 'done', verification: true, outputSummary: 'FAIL', sequence: 0 },
      { command: 'npm test', exitCode: 0, durationMs: 900, status: 'done', verification: true, outputSummary: '2 passed', sequence: 2 },
      { command: 'git push', exitCode: null, durationMs: 0, status: 'denied', verification: false, outputSummary: '', sequence: 3 },
    );
    store.recordRun({ sessionId: 's1', taskId: 't1', record, status: 'completed', mode: 'standard', providerId: 'p1', model: 'm1' });
    await store.dispose();

    const reopened = await open();
    const events = reopened.events({ taskId: 't1' });
    expect(events.map((e) => e.type)).toEqual(['run', 'changes_applied', 'changes_rejected', 'change_failed']);
    expect(events[0]?.data).toEqual({ status: 'completed', mode: 'standard', providerId: 'p1', model: 'm1' });
    expect(events[1]?.data).toEqual({ paths: ['src/a.ts'] });
    const evidence = reopened.verifications({ taskId: 't1' });
    expect(evidence.map((v) => [v.command, v.status, v.exitCode, v.isCheck])).toEqual([
      ['npm test', 'done', 1, true],
      ['npm test', 'done', 0, true],
      ['git push', 'denied', null, false],
    ]);
    expect(evidence[1]?.outputSummary).toBe('2 passed');
    expect(reopened.events({ taskId: 'other' })).toEqual([]);
    await reopened.dispose();
  });

  it('stores nothing for a run that did nothing and had no task', async () => {
    const store = await open();
    store.recordRun({ sessionId: 's1', record: newRunRecord(), status: 'completed', mode: 'quick' });
    expect(store.events()).toEqual([]);
    await store.dispose();
  });

  it('deletes a task together with its history', async () => {
    const store = await open();
    const task = sampleTask();
    store.save(task);
    store.recordEvent({ taskId: task.id, type: 'note', data: { text: 'x' } });
    store.deleteTask(task.id);
    expect(store.get(task.id)).toBeUndefined();
    expect(store.events({ taskId: task.id })).toEqual([]);
    await store.dispose();
  });

  it('keeps the file index, preserving hashes of unchanged files', async () => {
    const store = await open();
    store.saveFiles([
      { path: 'src/a.ts', size: 10, mtimeMs: 111.5, ext: 'ts', hash: 'ha' },
      { path: 'src/b.ts', size: 20, mtimeMs: 222, ext: 'ts', hash: 'hb' },
    ]);
    store.replaceSymbols('src/a.ts', [{ name: 'orderTotal', kind: 'function', line: 5 }]);
    store.replaceSymbols('src/b.ts', [{ name: 'OrderService', kind: 'class', line: 1 }]);
    // b changed on disk, a did not, c is new, and nothing lists b's old hash.
    store.saveFiles([
      { path: 'src/a.ts', size: 10, mtimeMs: 111.5, ext: 'ts' },
      { path: 'src/b.ts', size: 25, mtimeMs: 333, ext: 'ts' },
      { path: 'src/c.ts', size: 5, mtimeMs: 444, ext: 'ts' },
    ]);
    expect(store.fileCount()).toBe(3);
    expect(store.getFile('src/a.ts')?.hash).toBe('ha');
    expect(store.getFile('src/b.ts')?.hash).toBeUndefined();
    expect(store.findSymbols('ordertotal')).toEqual([{ path: 'src/a.ts', name: 'orderTotal', kind: 'function', line: 5 }]);

    store.saveFiles([{ path: 'src/a.ts', size: 10, mtimeMs: 111.5, ext: 'ts' }]);
    expect(store.findSymbols('OrderService')).toEqual([]);
    expect(store.symbolCount()).toBe(1);
    await store.dispose();
  });

  it('moves an unreadable database aside instead of failing or deleting it', async () => {
    const store = await open();
    store.save(sampleTask());
    await store.dispose();
    writeFileSync(dbPath, 'this is not a database, but the user may want it back');

    const recovered = await open();
    expect(recovered.list()).toEqual([]);
    expect(recovered.recoveredFrom).toMatch(/agent\.db\.unreadable-\d+$/);
    expect(readFileSync(recovered.recoveredFrom!, 'utf8')).toContain('user may want it back');
    recovered.save(sampleTask());
    await recovered.dispose();
    expect((await open()).list()).toHaveLength(1);
  });

  it('treats an empty file as a new database', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, '.byteagent'), { recursive: true });
    writeFileSync(dbPath, '');
    const store = await open();
    expect(store.list()).toEqual([]);
    expect(store.recoveredFrom).toBeUndefined();
    await store.dispose();
  });

  it('relocates the database file and keeps its contents', async () => {
    const elsewhere = join(dir, 'storage', 'agent.db');
    const store = await open(elsewhere);
    const task = sampleTask();
    store.save(task);
    await store.flush();
    await store.relocate(dbPath);
    expect(existsSync(elsewhere)).toBe(false);
    expect(store.path).toBe(dbPath);
    store.recordEvent({ taskId: task.id, type: 'after_move' });
    await store.dispose();
    const reopened = await open();
    expect(reopened.get(task.id)).toEqual(task);
    expect(reopened.events({ taskId: task.id }).map((e) => e.type)).toEqual(['after_move']);
    await reopened.dispose();
  });

  it('survives many quick writes and leaves no temporary files', async () => {
    const store = await open();
    for (let i = 0; i < 60; i++) store.recordEvent({ type: 'tick', data: { i } });
    await store.flush();
    for (let i = 0; i < 60; i++) store.recordEvent({ type: 'tock', data: { i } });
    await store.dispose();
    expect(readdirSync(join(dir, '.byteagent'))).toEqual(['agent.db']);
    const reopened = await open();
    expect(reopened.events({ limit: 1000 })).toHaveLength(120);
    await reopened.dispose();
  });

  it('does not treat stored text as SQL', async () => {
    const store = await open();
    const task = { ...sampleTask(), title: "x'); DROP TABLE tasks; --", goal: 'a "quoted" goal' };
    store.save(task);
    store.recordEvent({ type: "'; DELETE FROM events; --", data: { note: "it's fine" } });
    expect(store.get(task.id)?.title).toBe("x'); DROP TABLE tasks; --");
    expect(store.events()).toHaveLength(1);
    expect(store.findSymbols("' OR 1=1 --")).toEqual([]);
    await store.dispose();
  });

  it('keeps meta values', async () => {
    const store = await open();
    expect(store.getMeta('schema_version')).toBe('1');
    store.setMeta('onboarded_at', '123');
    store.setMeta('onboarded_at', '456');
    await store.dispose();
    expect((await open()).getMeta('onboarded_at')).toBe('456');
  });
});
