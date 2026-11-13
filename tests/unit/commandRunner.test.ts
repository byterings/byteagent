import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOutcome } from '../../src/agent/outcome';
import { nullLogger } from '../../src/shared/logger';
import { createToolRegistry } from '../../src/tools';
import { filterDiff } from '../../src/tools/builtin/gitTools';
import { runCommand, stripAnsi } from '../../src/tools/commandRunner';
import { newRunRecord, type CommandRecord, type PermissionClass, type RunRecord, type ToolContext } from '../../src/tools/types';
import { FakeHost, RecordingEvents } from '../integration/helpers';
import { tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace | undefined;
afterEach(() => {
  ws?.dispose();
  ws = undefined;
});

const node = (code: string): string => `node -e ${JSON.stringify(code)}`;

describe('runCommand', () => {
  it('captures exit code, stdout and stderr in the workspace folder', async () => {
    ws = tempWorkspace({ 'marker.txt': 'x' });
    const ok = await runCommand(node("console.log('out:' + require('fs').existsSync('marker.txt')); console.error('err line')"), { cwd: ws.root, timeoutMs: 10000 });
    expect(ok).toMatchObject({ status: 'done', exitCode: 0, truncated: false });
    expect(ok.output).toContain('out:true');
    expect(ok.output).toContain('err line');
    const failed = await runCommand(node('process.exit(3)'), { cwd: ws.root, timeoutMs: 10000 });
    expect(failed).toMatchObject({ status: 'done', exitCode: 3 });
  });

  it('reports a command that does not exist as a failed exit, not as success', async () => {
    ws = tempWorkspace({});
    const result = await runCommand('definitely-not-a-real-command-xyz', { cwd: ws.root, timeoutMs: 10000 });
    expect(result.status).toBe('done');
    expect(result.exitCode).not.toBe(0);
  });

  it('stops a command at the time limit, including its child processes', async () => {
    ws = tempWorkspace({});
    const started = Date.now();
    const result = await runCommand(`${node("setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 1500); setInterval(() => {}, 1000)")} & wait`, { cwd: ws.root, timeoutMs: 300 });
    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
    await new Promise((r) => setTimeout(r, 1700));
    expect(existsSync(join(ws.root, 'late.txt'))).toBe(false);
  });

  it('stops when cancelled and does not start when already cancelled', async () => {
    ws = tempWorkspace({});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const result = await runCommand(node('setInterval(() => {}, 1000)'), { cwd: ws.root, timeoutMs: 10000, signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(result.exitCode).toBeNull();
    const never = await runCommand(node("require('fs').writeFileSync('ran.txt','x')"), { cwd: ws.root, timeoutMs: 10000, signal: controller.signal });
    expect(never.status).toBe('cancelled');
    expect(existsSync(join(ws.root, 'ran.txt'))).toBe(false);
  });

  it('bounds very long output, keeping the start and the end', async () => {
    ws = tempWorkspace({});
    const result = await runCommand(node("console.log('FIRST'); for (let i = 0; i < 20000; i++) console.log('filler line ' + i); console.log('LAST')"), { cwd: ws.root, timeoutMs: 15000 });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(60000);
    expect(result.output.startsWith('FIRST')).toBe(true);
    expect(result.output.endsWith('LAST')).toBe(true);
    expect(result.output).toMatch(/characters of output removed/);
  });

  it('removes terminal colour codes and runs without a terminal', async () => {
    ws = tempWorkspace({});
    const result = await runCommand(node("process.stdout.write('\\u001b[31mred\\u001b[0m ' + process.env.CI + ' ' + Boolean(process.stdout.isTTY))"), { cwd: ws.root, timeoutMs: 10000 });
    expect(result.output).toBe('red true false');
    expect(stripAnsi('\u001b[1;32mok\u001b[0m\u001b]0;title\u0007 done')).toBe('ok done');
  });

  it('streams output while the command runs', async () => {
    ws = tempWorkspace({});
    const seen: string[] = [];
    await runCommand(node("console.log('one'); setTimeout(() => console.log('two'), 700)"), { cwd: ws.root, timeoutMs: 10000, onOutput: (o) => seen.push(o) });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toContain('one');
  });
});

describe('buildOutcome', () => {
  const command = (over: Partial<CommandRecord>): CommandRecord => ({ command: 'npm test', exitCode: 0, durationMs: 10, status: 'done', verification: true, outputSummary: '', sequence: 0, ...over });
  const record = (over: Partial<RunRecord>): RunRecord => ({ ...newRunRecord(), ...over });

  it('returns nothing when the run did nothing', () => {
    expect(buildOutcome(newRunRecord(), null)).toBeUndefined();
  });

  it('says "not verified" when no check ran, whatever else happened', () => {
    const outcome = buildOutcome(record({ applied: ['a.ts'], lastAppliedAt: 0, commands: [command({ command: 'git status', verification: false, sequence: 1 })] }), null);
    expect(outcome?.verification).toBe('not_run');
    expect(outcome?.applied).toEqual(['a.ts']);
  });

  it('says "passed" only when a check exited with 0 after the last change', () => {
    expect(buildOutcome(record({ applied: ['a.ts'], lastAppliedAt: 0, commands: [command({ sequence: 1 })] }), null)?.verification).toBe('passed');
    const stale = buildOutcome(record({ applied: ['a.ts'], lastAppliedAt: 2, commands: [command({ sequence: 1 })] }), null);
    expect(stale?.verification).toBe('not_run');
    expect(stale?.notes.join(' ')).toMatch(/changed after the last check/);
  });

  it('says "failed" when the latest run of any check failed, timed out or was stopped', () => {
    expect(buildOutcome(record({ commands: [command({ exitCode: 1 })] }), null)?.verification).toBe('failed');
    expect(buildOutcome(record({ commands: [command({ status: 'timeout', exitCode: null })] }), null)?.verification).toBe('failed');
    expect(buildOutcome(record({ commands: [command({ sequence: 0 }), command({ command: 'npm run lint', exitCode: 2, sequence: 1 })] }), null)?.verification).toBe('failed');
  });

  it('uses the most recent run of a check that was repeated', () => {
    const fixed = buildOutcome(record({ commands: [command({ exitCode: 1, sequence: 0 }), command({ exitCode: 0, sequence: 2 })], lastAppliedAt: 1, applied: ['a.ts'] }), null);
    expect(fixed?.verification).toBe('passed');
    const broke = buildOutcome(record({ commands: [command({ exitCode: 0, sequence: 0 }), command({ exitCode: 1, sequence: 2 })] }), null);
    expect(broke?.verification).toBe('failed');
  });

  it('never counts a denied command as run', () => {
    const outcome = buildOutcome(record({ commands: [command({ status: 'denied', exitCode: null })] }), null);
    expect(outcome?.verification).toBe('not_run');
    expect(outcome?.commands).toEqual([]);
    expect(outcome?.notes[0]).toMatch(/Not run, because you denied it: npm test/);
  });

  it('lists rejected, stale and failed files without calling them applied', () => {
    const outcome = buildOutcome(record({ applied: ['a.ts', 'a.ts'], rejected: ['a.ts', 'b.ts'], stale: ['c.ts'], failed: [{ path: 'd.ts', error: 'Permission denied.' }] }), { errors: 1, warnings: 2, files: ['a.ts'] });
    expect(outcome?.applied).toEqual(['a.ts']);
    expect(outcome?.rejected).toEqual(['b.ts']);
    expect(outcome?.failed).toEqual([{ path: 'd.ts', error: 'Permission denied.' }, { path: 'c.ts', error: 'the file changed before the change could be applied' }]);
    expect(outcome?.diagnostics).toEqual({ errors: 1, warnings: 2, files: ['a.ts'] });
  });
});

describe('git tools', () => {
  const READ: ReadonlySet<PermissionClass> = new Set(['read']);
  const call = (name: string, args: unknown = {}) => ({ id: 'c', name, arguments: JSON.stringify(args) });
  const gitAvailable = (() => {
    try {
      execFileSync('git', ['--version']);
      return true;
    } catch {
      return false;
    }
  })();

  function context(): ToolContext {
    return { index: ws!.index(), signal: new AbortController().signal, host: new FakeHost(ws!.root), events: new RecordingEvents(), record: newRunRecord(), logger: nullLogger, redact: (t) => t };
  }
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: ws!.root, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  };

  it('removes diff sections for files the agent may not see', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      'diff --git a/.env b/.env\nindex 1..2 100644\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-KEY=old\n+KEY=supersecret\n',
    ].join('');
    const filtered = filterDiff(diff, (p) => p !== '.env');
    expect(filtered.hidden).toEqual(['.env']);
    expect(filtered.text).toContain('src/a.ts');
    expect(filtered.text).not.toContain('supersecret');
  });

  it('says so when the folder is not a repository', async () => {
    ws = tempWorkspace({ 'a.txt': 'x' });
    const result = await createToolRegistry().invoke(call('git_status'), context(), READ);
    if (gitAvailable) expect(result.content).toBe('This folder is not a Git repository.');
    expect(result.ok).toBe(false);
  });

  it.skipIf(!gitAvailable)('shows status and diff, hiding sensitive file contents even when tracked', async () => {
    ws = tempWorkspace({ 'src/a.ts': 'export const a = 1;\n', '.env': 'KEY=original\n', 'README.md': 'hi\n' });
    git('init', '-q', '-b', 'main');
    git('add', '-A', '-f');
    git('commit', '-q', '-m', 'init');
    ws.write('src/a.ts', 'export const a = 2;\n');
    ws.write('.env', 'KEY=supersecretvalue\n');
    ws.write('new.txt', 'untracked\n');
    const registry = createToolRegistry();

    const status = await registry.invoke(call('git_status'), context(), READ);
    expect(status.content).toContain('Branch: main');
    expect(status.content).toContain(' M src/a.ts');
    expect(status.content).toContain('?? new.txt');

    const diff = await registry.invoke(call('git_diff'), context(), READ);
    expect(diff.content).toContain('+export const a = 2;');
    expect(diff.content).not.toContain('supersecretvalue');
    expect(diff.content).toMatch(/1 excluded or sensitive file are not shown|1 excluded or sensitive file/);

    expect((await registry.invoke(call('git_diff', { path: 'src/a.ts' }), context(), READ)).content).toContain('+export const a = 2;');
    expect((await registry.invoke(call('git_diff', { path: '.env' }), context(), READ)).content).toMatch(/sensitive file/);
    expect((await registry.invoke(call('git_diff', { staged: true }), context(), READ)).content).toBe('No staged changes.');
    expect((await registry.invoke(call('git_diff', { path: 'README.md' }), context(), READ)).content).toBe('No unstaged changes.');
  });
});
