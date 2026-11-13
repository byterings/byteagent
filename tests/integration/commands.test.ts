import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime';
import { createProvider } from '../../src/providers/factory';
import { nullLogger } from '../../src/shared/logger';
import { createToolRegistry } from '../../src/tools';
import { tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';
import { MockServer, type MockReply } from '../mock/mockServer';
import { acceptAll, FakeHost, RecordingEvents } from './helpers';

const server = new MockServer();
let baseUrl = '';
let ws: TempWorkspace;
beforeAll(async () => {
  baseUrl = await server.start();
});
afterAll(() => server.stop());
afterEach(() => {
  server.reset();
  ws?.dispose();
});

/** A tiny project whose test passes only when add() is correct. */
const project = (addBody = 'return a - b;'): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'calc', scripts: { test: 'node test.js', lint: 'node lint.js' } }),
  'src/math.js': `function add(a, b) {\n  ${addBody}\n}\nmodule.exports = { add };\n`,
  'test.js': "const { add } = require('./src/math');\nif (add(2, 3) !== 5) { console.error('FAIL: add(2, 3) should be 5'); process.exit(1); }\nconsole.log('1 test passed');\n",
  'lint.js': "console.log('lint ok');\n",
  '.env': 'API_TOKEN=tok-live-1234567890abcdef\n',
});

function setup(files = project()) {
  ws = tempWorkspace(files);
  const events = new RecordingEvents();
  const host = new FakeHost(ws.root);
  const runtime = new AgentRuntime({
    provider: createProvider({ id: 'mock', baseUrl, model: 'mock-model', timeoutSeconds: 5, toolCalling: 'native' }, { retryBaseDelayMs: 5 }),
    events,
    host,
    logger: nullLogger,
    workspace: { index: ws.index() },
    tools: createToolRegistry(),
    limits: { defaultContextWindow: 32000, confirmBeforeSend: false },
    redact: (text) => text.split('tok-live-1234567890abcdef').join('[REDACTED]'),
  });
  const run = (prompt: string, signal = new AbortController().signal) => runtime.run({ prompt, attachments: [], mode: 'auto', history: [] }, signal);
  return { events, host, run };
}

const command = (cmd: string, purpose = 'Check the work'): MockReply => ({ type: 'tools', calls: [{ name: 'run_command', arguments: { command: cmd, purpose } }] });
const text = (t: string): MockReply => ({ type: 'text', text: t });
const toolResults = (n: number): string[] =>
  (server.chatRequests[n]!.body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => m.content);
const FIX = { type: 'tools', calls: [{ name: 'propose_changes', arguments: { summary: 'Fix add', changes: [{ path: 'src/math.js', action: 'edit', edits: [{ search: 'return a - b;', replace: 'return a + b;' }] }] } }] } as MockReply;
const marker = (name: string): string => `node -e "require('fs').writeFileSync('${name}', 'ran')"`;

describe('run_command approval', () => {
  it('does not run a command the user denies, and tells the model it was not run', async () => {
    server.enqueue(command(marker('ran.txt')), text('I could not run it.'));
    const { events, host, run } = setup();
    const result = await run('run it');

    expect(host.commandRequests).toHaveLength(1);
    expect(existsSync(join(ws.root, 'ran.txt'))).toBe(false);
    expect(events.of('command')[0]).toMatchObject({ status: 'denied' });
    expect(toolResults(1)[0]).toMatch(/The user denied this command\. It was NOT run/);
    expect(result.record.commands[0]).toMatchObject({ status: 'denied', exitCode: null });
    const outcome = events.of('outcome')[0]?.outcome;
    expect(outcome?.commands).toEqual([]);
    expect(outcome?.verification).toBe('not_run');
    expect(result.turn?.notes).toContain('Command not run (denied by the user)');
  });

  it('runs an approved command once and returns the real exit code and output', async () => {
    server.enqueue(command('npm test'), text('The test fails: add is wrong.'));
    const { events, host, run } = setup();
    host.approver = () => 'once';
    const result = await run('run the tests');

    expect(host.commandRequests[0]).toMatchObject({ command: 'npm test', risk: 'safe', canRemember: true });
    const card = events.of('command')[0];
    expect(card).toMatchObject({ status: 'done', exitCode: 1, verification: true, remembered: false });
    expect(card?.output).toContain('FAIL: add(2, 3) should be 5');
    expect(card?.durationMs).toBeGreaterThan(0);
    expect(toolResults(1)[0]).toContain('Exit code: 1');
    expect(toolResults(1)[0]).toContain('FAIL: add(2, 3) should be 5');
    expect(result.record.commands[0]).toMatchObject({ command: 'npm test', exitCode: 1, verification: true });
    expect(events.of('outcome')[0]?.outcome.verification).toBe('failed');
    expect(host.remembered.size).toBe(0);
  });

  it('remembers "always allow" for a safe command and stops asking for exactly that command', async () => {
    server.enqueue(command('npm run lint'), command('npm run lint'), command('npm test'), text('done'));
    const { events, host, run } = setup();
    host.approver = (request) => (request.command === 'npm run lint' ? 'always' : 'deny');
    await run('lint twice then test');

    expect(host.commandRequests.map((r) => r.command)).toEqual(['npm run lint', 'npm test']);
    expect(host.remembered.has('npm run lint')).toBe(true);
    const cards = events.of('command');
    expect(cards.map((c) => [c.command, c.status, c.remembered])).toEqual([
      ['npm run lint', 'done', true],
      ['npm run lint', 'done', true],
      ['npm test', 'denied', false],
    ]);
  });

  it('never remembers a destructive or chained command, even when "always" is answered', async () => {
    server.enqueue(command('rm -f lint.js'), command('rm -f lint.js'), command('npm run lint && npm test'), command('npm run lint && npm test'), text('done'));
    const { events, host, run } = setup();
    host.approver = () => 'always';
    await run('do risky things');

    expect(host.commandRequests).toHaveLength(4);
    expect(host.commandRequests[0]).toMatchObject({ risk: 'destructive', canRemember: false });
    expect(host.commandRequests[0]?.reasons.join(' ')).toMatch(/Deletes files/);
    expect(host.commandRequests[2]).toMatchObject({ canRemember: false });
    expect(host.remembered.size).toBe(0);
    expect(events.of('command').every((c) => !c.remembered)).toBe(true);
  });

  it('asks for a command even after the user accepted a file change (separate permissions)', async () => {
    server.enqueue(FIX, command(marker('after-diff.txt')), text('done'));
    const { host, run } = setup();
    host.reviewer = acceptAll;
    await run('fix and run');
    expect(host.reviews).toHaveLength(1);
    expect(host.commandRequests).toHaveLength(1);
    expect(existsSync(join(ws.root, 'after-diff.txt'))).toBe(false);
  });

  it('flags a command that reads a sensitive file and redacts secrets from its output', async () => {
    server.enqueue(command('cat .env'), text('done'));
    const { events, host, run } = setup();
    host.approver = () => 'once';
    await run('show env');
    expect(host.commandRequests[0]).toMatchObject({ risk: 'destructive', canRemember: false });
    expect(host.commandRequests[0]?.reasons.join(' ')).toMatch(/sensitive file/);
    expect(JSON.stringify(server.chatRequests[1]!.body)).not.toContain('tok-live-1234567890abcdef');
    expect(events.of('command')[0]?.output).not.toContain('tok-live-1234567890abcdef');
  });

  it('stops a command at the time limit and reports that the result is unknown', async () => {
    server.enqueue(command('node -e "setInterval(() => {}, 1000)"'), text('It timed out.'));
    const { events, host, run } = setup();
    host.approver = () => 'once';
    host.commandTimeoutMs = 300;
    await run('hang');
    expect(events.of('command')[0]).toMatchObject({ status: 'timeout', exitCode: null });
    expect(toolResults(1)[0]).toMatch(/exceeded the time limit\. It did not finish, so its result is unknown/);
    expect(events.of('outcome')[0]?.outcome.notes.join(' ')).toMatch(/Stopped at the time limit/);
  });

  it('stops a running command when the run is cancelled', async () => {
    server.enqueue(command('node -e "setInterval(() => {}, 1000)"'), text('never'));
    const { events, host, run } = setup();
    const controller = new AbortController();
    host.approver = () => {
      setTimeout(() => controller.abort(), 200);
      return 'once';
    };
    const started = Date.now();
    const result = await run('hang', controller.signal);
    expect(result.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(events.of('command')[0]?.status).toBe('cancelled');
    expect(server.chatRequests).toHaveLength(1);
  });

  it('denies a waiting command when the run is cancelled before the answer', async () => {
    server.enqueue(command(marker('ran.txt')), text('never'));
    const { host, run } = setup();
    const controller = new AbortController();
    host.approver = () => {
      controller.abort();
      return 'deny';
    };
    const result = await run('run', controller.signal);
    expect(result.status).toBe('cancelled');
    expect(existsSync(join(ws.root, 'ran.txt'))).toBe(false);
  });
});

describe('verification evidence (Scenario C: change, then verify)', () => {
  it('records a verified result only from a real passing run after the change', async () => {
    server.enqueue(
      { type: 'tools', calls: [{ name: 'read_file', arguments: { path: 'src/math.js' } }] },
      command('npm test', 'See the current failure'),
      FIX,
      command('npm test', 'Confirm the fix'),
      text('add() now returns the sum, and the test passes.'),
    );
    const { events, host, run } = setup();
    host.reviewer = acceptAll;
    host.approver = () => 'once';
    host.diagnostics = { errors: 0, warnings: 0, files: [] };
    const result = await run('The add function is wrong. Fix it and run the tests.');

    expect(readFileSync(join(ws.root, 'src/math.js'), 'utf8')).toContain('return a + b;');
    expect(events.of('command').map((c) => c.exitCode)).toEqual([1, 0]);
    expect(host.diagnosticRequests).toEqual([['src/math.js']]);

    const outcome = events.of('outcome')[0]?.outcome;
    expect(outcome).toEqual({
      applied: ['src/math.js'],
      rejected: [],
      failed: [],
      commands: [
        { command: 'npm test', exitCode: 1, passed: false, verification: true },
        { command: 'npm test', exitCode: 0, passed: true, verification: true },
      ],
      diagnostics: { errors: 0, warnings: 0, files: [] },
      verification: 'passed',
      notes: [],
    });
    expect(events.kinds.at(-1)).toBe('outcome');
    expect(result.turn?.notes).toBe('Files changed (approved by the user): src/math.js\nCommand run: npm test → exit code 1\nCommand run: npm test → exit code 0');
  });

  it('does not report "verified" when the model claims success but no check ran', async () => {
    server.enqueue(FIX, text('Fixed! All tests pass now.'));
    const { events, host, run } = setup();
    host.reviewer = acceptAll;
    await run('fix add');
    const outcome = events.of('outcome')[0]?.outcome;
    expect(outcome?.applied).toEqual(['src/math.js']);
    expect(outcome?.commands).toEqual([]);
    expect(outcome?.verification).toBe('not_run');
  });

  it('does not report "verified" when files changed after the last passing check', async () => {
    server.enqueue(
      command('npm run lint'),
      FIX,
      text('Lint passed earlier and I changed the file afterwards.'),
    );
    const { events, host, run } = setup();
    host.reviewer = acceptAll;
    host.approver = () => 'once';
    await run('lint then fix');
    const outcome = events.of('outcome')[0]?.outcome;
    expect(outcome?.verification).toBe('not_run');
    expect(outcome?.notes.join(' ')).toMatch(/changed after the last check/);
  });

  it('reports a failed check as failed even if the model says otherwise', async () => {
    server.enqueue(command('npm test'), text('Everything looks great!'));
    const { events, host, run } = setup();
    host.approver = () => 'once';
    await run('test');
    expect(events.of('outcome')[0]?.outcome.verification).toBe('failed');
  });

  it('shows no outcome card for a plain question', async () => {
    server.enqueue(text('It adds two numbers.'));
    const { events, run } = setup();
    await run('what does add do?');
    expect(events.of('outcome')).toEqual([]);
  });

  it('still reports what was applied when the run fails afterwards', async () => {
    server.enqueue(FIX, { type: 'error', status: 401, body: { error: { message: 'revoked' } } });
    const { events, host, run } = setup();
    host.reviewer = acceptAll;
    const result = await run('fix add');
    expect(result.status).toBe('failed');
    expect(events.of('outcome')[0]?.outcome.applied).toEqual(['src/math.js']);
    expect(events.of('outcome')[0]?.outcome.verification).toBe('not_run');
  });
});
