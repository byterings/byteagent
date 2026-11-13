import { symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countLines, looksBinary } from '../../src/context/workspaceIndex';
import { ByteAgentError } from '../../src/shared/errors';
import { ABSENT_HASH, sha256 } from '../../src/shared/hash';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace | undefined;
afterEach(() => {
  ws?.dispose();
  ws = undefined;
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof ByteAgentError ? err.code : `other:${String(err)}`;
  }
  return 'none';
}

describe('WorkspaceIndex scan', () => {
  it('indexes allowed files and counts what it skipped', async () => {
    ws = tempWorkspace(sampleProject());
    const index = ws.index();
    const stats = await index.refresh();
    const paths = index.files().map((f) => f.path).sort();
    expect(paths).toContain('src/services/pricing.ts');
    expect(paths).toContain('.env.example');
    expect(paths).toContain('.gitignore');
    for (const blocked of ['.env', 'node_modules/express/index.js', 'dist/app.js', 'debug.log', 'config/secrets.yaml', 'certs/server.pem']) {
      expect(paths, blocked).not.toContain(blocked);
    }
    expect(stats.files).toBe(paths.length);
    expect(stats.skipped.sensitive).toBe(3);
    expect(stats.skipped.default).toBe(1);
    expect(stats.skipped.gitignore).toBe(2);
    expect(stats.truncated).toBe(false);
  });

  it('skips files over the size limit and symlinks', async () => {
    ws = tempWorkspace({ 'small.txt': 'ok', 'big.txt': 'x'.repeat(5000) });
    symlinkSync(join(ws.root, 'small.txt'), join(ws.root, 'link.txt'));
    const index = ws.index({ maxFileSizeBytes: 1000 });
    const stats = await index.refresh();
    expect(index.files().map((f) => f.path)).toEqual(['small.txt']);
    expect(stats.skipped.too_large).toBe(1);
    expect(stats.skipped.symlink).toBe(1);
  });

  it('stops at the file limit and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${String(i).padStart(2, '0')}.txt`] = 'x';
    ws = tempWorkspace(files);
    const index = ws.index({ maxFiles: 10 });
    const stats = await index.refresh();
    expect(index.fileCount).toBe(10);
    expect(stats.truncated).toBe(true);
  });

  it('rescans only when marked dirty', async () => {
    ws = tempWorkspace({ 'a.txt': '1' });
    const index = ws.index();
    await index.ensureFresh();
    ws.write('b.txt', '2');
    await index.ensureFresh();
    expect(index.has('b.txt')).toBe(false);
    index.markDirty();
    await index.ensureFresh();
    expect(index.has('b.txt')).toBe(true);
  });

  it('updates single paths without a full scan', async () => {
    ws = tempWorkspace({ 'a.txt': '1', 'dir/x.txt': '1', 'dir/y.txt': '1' });
    const index = ws.index();
    await index.refresh();
    ws.write('new.ts', 'x');
    ws.write('.env', 'SECRET=1');
    await index.refreshPath('new.ts');
    await index.refreshPath('.env');
    expect(index.has('new.ts')).toBe(true);
    expect(index.has('.env')).toBe(false);
    ws.remove('a.txt');
    await index.refreshPath('a.txt');
    expect(index.has('a.txt')).toBe(false);
    ws.remove('dir');
    await index.refreshPath('dir');
    expect(index.files().map((f) => f.path)).toEqual(['new.ts']);
  });
});

describe('WorkspaceIndex reads', () => {
  it('reads text with a hash and line count', async () => {
    ws = tempWorkspace({ 'a.txt': 'one\ntwo\nthree\n' });
    const index = ws.index();
    const file = await index.readText('./a.txt');
    expect(file).toMatchObject({ path: 'a.txt', text: 'one\ntwo\nthree\n', lineCount: 3, source: 'disk', hash: sha256('one\ntwo\nthree\n') });
  });

  it('returns fresh content after the file changes on disk', async () => {
    ws = tempWorkspace({ 'a.txt': 'old content' });
    const index = ws.index();
    expect((await index.readText('a.txt')).text).toBe('old content');
    ws.write('a.txt', 'new content!');
    expect((await index.readText('a.txt')).text).toBe('new content!');
    // Same size, different time: still detected.
    ws.write('a.txt', 'NEW CONTENT!');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(ws.root, 'a.txt'), future, future);
    expect((await index.readText('a.txt')).text).toBe('NEW CONTENT!');
  });

  it('prefers unsaved editor text', async () => {
    ws = tempWorkspace({ 'a.txt': 'on disk' });
    const index = ws.index({ overlay: (p) => (p === 'a.txt' ? 'unsaved edit' : undefined) });
    const file = await index.readText('a.txt');
    expect(file).toMatchObject({ text: 'unsaved edit', source: 'editor', hash: sha256('unsaved edit') });
    expect(await index.currentHash('a.txt')).toBe(sha256('unsaved edit'));
  });

  it('refuses sensitive, ignored, outside, missing, binary, large files and folders', async () => {
    ws = tempWorkspace({ ...sampleProject(), 'image.png': 'fake', 'data.bin2': new Uint8Array([1, 0, 2, 0, 3]), 'huge.txt': 'x'.repeat(4000) });
    const index = ws.index({ maxFileSizeBytes: 2000 });
    expect(await codeOf(index.readText('.env'))).toBe('path_sensitive');
    expect(await codeOf(index.readText('certs/server.pem'))).toBe('path_sensitive');
    expect(await codeOf(index.readText('node_modules/express/index.js'))).toBe('path_excluded');
    expect(await codeOf(index.readText('dist/app.js'))).toBe('path_excluded');
    expect(await codeOf(index.readText('.git/config'))).toBe('path_excluded');
    expect(await codeOf(index.readText('../outside'))).toBe('path_outside_workspace');
    expect(await codeOf(index.readText('/etc/hostname'))).toBe('path_outside_workspace');
    expect(await codeOf(index.readText('src/missing.ts'))).toBe('not_found');
    expect(await codeOf(index.readText('image.png'))).toBe('binary_file');
    expect(await codeOf(index.readText('data.bin2'))).toBe('binary_file');
    expect(await codeOf(index.readText('huge.txt'))).toBe('file_too_large');
    expect(await codeOf(index.readText('src'))).toBe('invalid_arguments');
  });

  it('reads clamped line ranges', async () => {
    ws = tempWorkspace({ 'a.txt': 'l1\nl2\nl3\nl4\nl5' });
    const index = ws.index();
    expect(await index.readLines('a.txt', 2, 3)).toMatchObject({ text: 'l2\nl3', startLine: 2, endLine: 3 });
    expect(await index.readLines('a.txt', 4, 99)).toMatchObject({ text: 'l4\nl5', startLine: 4, endLine: 5 });
    expect(await index.readLines('a.txt', -5, 1)).toMatchObject({ text: 'l1', startLine: 1, endLine: 1 });
  });

  it('reports the hash of the current content, or absent', async () => {
    ws = tempWorkspace({ 'a.txt': 'v1' });
    const index = ws.index();
    expect(await index.currentHash('a.txt')).toBe(sha256('v1'));
    ws.write('a.txt', 'v2');
    expect(await index.currentHash('a.txt')).toBe(sha256('v2'));
    expect(await index.currentHash('nope.txt')).toBe(ABSENT_HASH);
  });

  it('lists directories without blocked entries', async () => {
    ws = tempWorkspace(sampleProject());
    const index = ws.index();
    await index.refresh();
    const rootNames = (await index.listDirectory('.')).map((e) => e.name);
    expect(rootNames).toContain('src');
    expect(rootNames).toContain('package.json');
    for (const hidden of ['.env', 'node_modules', 'dist', 'debug.log']) expect(rootNames, hidden).not.toContain(hidden);
    expect(rootNames.indexOf('src')).toBeLessThan(rootNames.indexOf('package.json'));
    // Folders that hold only blocked files are visible but appear empty.
    expect((await index.listDirectory('config')).map((e) => e.name)).toEqual([]);
    expect((await index.listDirectory('certs')).map((e) => e.name)).toEqual([]);
    expect(await codeOf(index.listDirectory('node_modules'))).toBe('path_excluded');
    expect(await codeOf(index.listDirectory('nope'))).toBe('not_found');
    expect(await codeOf(index.listDirectory('package.json'))).toBe('invalid_arguments');
  });
});

describe('helpers', () => {
  it('detects binary content', () => {
    expect(looksBinary(new Uint8Array([104, 105, 0, 1]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('plain text\nwith lines\tand tabs'))).toBe(false);
    expect(looksBinary(new TextEncoder().encode('héllo 世界'))).toBe(false);
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });
  it('counts lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
  });
});
