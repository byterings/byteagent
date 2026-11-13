import * as assert from 'node:assert';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ByteAgentApi } from '../../src/extension';
import type { ChatItem, HostMessage } from '../../src/shared/protocol';
import { MockServer, type MockReply } from '../mock/mockServer';
import { activate, resetSettings, waitFor } from './helpers';

type CommandItem = Extract<ChatItem, { kind: 'command' }>;

describe('M5 commands and verification', () => {
  const server = new MockServer();
  let api: ByteAgentApi;
  const posted: HostMessage[] = [];
  const root = (): string => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const file = (rel: string): string => path.join(root(), rel);
  let originalMath = '';

  const command = (cmd: string): MockReply => ({ type: 'tools', calls: [{ name: 'run_command', arguments: { command: cmd, purpose: 'test' } }] });
  const text = (t: string): MockReply => ({ type: 'text', text: t });
  const items = (): ChatItem[] => api.controller.currentSession.items;
  const cards = (): CommandItem[] => items().filter((i): i is CommandItem => i.kind === 'command');
  const send = (t: string) => api.controller.handleMessage({ type: 'sendPrompt', text: t, mode: 'auto', attachments: [] });
  const pendingCard = async (): Promise<CommandItem> => {
    await waitFor(() => cards().some((c) => c.status === 'pending'), 'command approval shown');
    return cards().find((c) => c.status === 'pending')!;
  };
  const decide = (card: CommandItem, decision: 'once' | 'always' | 'deny') => api.controller.handleMessage({ type: 'commandDecision', requestId: card.requestId, decision });
  const marker = (name: string): string => `node -e "require('fs').writeFileSync('${name}', 'ran')"`;

  before(async () => {
    api = await activate();
    const baseUrl = await server.start();
    await resetSettings();
    await vscode.workspace
      .getConfiguration('byteagent')
      .update('providers', [{ id: 'mock', name: 'Mock', baseUrl, model: 'mock-model', timeoutSeconds: 5, toolCalling: 'native' }], vscode.ConfigurationTarget.Global);
    originalMath = readFileSync(file('src/math.js'), 'utf8');
  });

  beforeEach(async () => {
    server.reset();
    api.controller.attach((m) => posted.push(m));
    posted.length = 0;
    await api.controller.forgetCommands();
    for (const name of ['marker-a.txt', 'marker-b.txt']) rmSync(file(name), { force: true });
    writeFileSync(file('src/math.js'), originalMath);
    await api.controller.newChat();
  });

  after(async () => {
    api.controller.detach();
    await server.stop();
    await api.controller.forgetCommands();
    await resetSettings();
  });

  it('waits for approval, then runs the command and records the real result', async () => {
    server.enqueue(command('npm test'), text('The tests pass.'));
    await send('run the tests');
    const card = await pendingCard();
    assert.deepStrictEqual([card.command, card.risk, card.canRemember, card.verification], ['npm test', 'safe', true, true]);
    assert.strictEqual(server.chatRequests.length, 1, 'model waits for the result');

    await decide(card, 'once');
    await api.controller.whenIdle();

    const done = cards()[0]!;
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.exitCode, 0);
    assert.ok(done.output?.includes('2 tests passed'), `output was: ${done.output}`);
    const toolMessage = server.chatRequests[1]?.body.messages.find((m: { role: string }) => m.role === 'tool');
    assert.ok(toolMessage.content.includes('Exit code: 0') && toolMessage.content.includes('2 tests passed'));

    const outcome = items().find((i) => i.kind === 'outcome');
    assert.ok(outcome && outcome.kind === 'outcome');
    assert.strictEqual(outcome.outcome.verification, 'passed');
    assert.deepStrictEqual(outcome.outcome.commands, [{ command: 'npm test', exitCode: 0, passed: true, verification: true }]);
    assert.deepStrictEqual(api.controller.rememberedCommands(), []);
  });

  it('does not run a denied command', async () => {
    server.enqueue(command(marker('marker-a.txt')), text('Not run.'));
    await send('write a marker');
    const card = await pendingCard();
    assert.strictEqual(card.risk, 'moderate');
    assert.strictEqual(card.canRemember, false);
    await decide(card, 'deny');
    await api.controller.whenIdle();
    assert.strictEqual(existsSync(file('marker-a.txt')), false);
    assert.strictEqual(cards()[0]?.status, 'denied');
    assert.ok(server.chatRequests[1]?.body.messages.some((m: { role: string; content: string }) => m.role === 'tool' && m.content.includes('It was NOT run')));
  });

  it('treats an unknown decision value as a denial', async () => {
    server.enqueue(command(marker('marker-a.txt')), text('ok'));
    await send('write a marker');
    const card = await pendingCard();
    await api.controller.handleMessage({ type: 'commandDecision', requestId: card.requestId, decision: 'sure' as unknown as 'once' });
    await api.controller.whenIdle();
    assert.strictEqual(existsSync(file('marker-a.txt')), false);
  });

  it('remembers "always allow" per workspace for a safe command, and can forget it', async () => {
    server.enqueue(command('npm test'), text('done'));
    await send('test');
    await decide(await pendingCard(), 'always');
    await api.controller.whenIdle();
    assert.deepStrictEqual(api.controller.rememberedCommands(), ['npm test']);

    server.enqueue(command('npm test'), text('done again'));
    await api.controller.newChat();
    await send('test again');
    await api.controller.whenIdle();
    const second = cards()[0]!;
    assert.strictEqual(second.status, 'done', 'ran without asking');
    assert.strictEqual(second.remembered, true);
    assert.strictEqual(api.controller.pendingCount, 0);

    assert.strictEqual(await vscode.commands.executeCommand('byteagent.resetCommandApprovals'), 1);
    assert.deepStrictEqual(api.controller.rememberedCommands(), []);
  });

  it('never remembers a risky command even when "always" is sent', async () => {
    server.enqueue(command(marker('marker-a.txt')), command(marker('marker-a.txt')), text('done'));
    await send('marker twice');
    await decide(await pendingCard(), 'always');
    await waitFor(() => cards().length === 2 && cards()[1]?.status === 'pending', 'asked again for the same command');
    assert.deepStrictEqual(api.controller.rememberedCommands(), []);
    await decide(cards()[1]!, 'deny');
    await api.controller.whenIdle();
    assert.strictEqual(existsSync(file('marker-a.txt')), true, 'first run happened');
  });

  it('approving a file change does not approve a command', async () => {
    server.enqueue(
      { type: 'tools', calls: [{ name: 'propose_changes', arguments: { changes: [{ path: 'src/math.js', action: 'edit', edits: [{ search: 'return a + b;', replace: 'return a + b; // ok' }] }] } }] },
      command(marker('marker-b.txt')),
      text('done'),
    );
    await send('change and run');
    await waitFor(() => items().some((i) => i.kind === 'changes' && i.status === 'pending'), 'review shown');
    const review = items().find((i) => i.kind === 'changes')!;
    assert.ok(review.kind === 'changes');
    await api.controller.handleMessage({ type: 'reviewDecision', changeSetId: review.changeSetId, decisions: { [review.files[0]!.changeId]: 'accept' } });
    const card = await pendingCard();
    assert.strictEqual(existsSync(file('marker-b.txt')), false, 'command still waits for its own approval');
    await decide(card, 'deny');
    await api.controller.whenIdle();
    assert.strictEqual(existsSync(file('marker-b.txt')), false);
    assert.ok(readFileSync(file('src/math.js'), 'utf8').includes('// ok'));

    const outcome = items().find((i) => i.kind === 'outcome');
    assert.ok(outcome && outcome.kind === 'outcome');
    assert.deepStrictEqual(outcome.outcome.applied, ['src/math.js']);
    assert.strictEqual(outcome.outcome.verification, 'not_run');
    assert.ok(outcome.outcome.diagnostics !== null, 'editor diagnostics were read for the changed file');
  });

  it('stops a running command when the user presses stop', async () => {
    server.enqueue(command('node -e "setInterval(() => {}, 1000)"'), text('never'));
    await send('hang');
    await decide(await pendingCard(), 'once');
    await waitFor(() => cards()[0]?.status === 'running', 'command running');
    await api.controller.handleMessage({ type: 'stop' });
    await api.controller.whenIdle();
    assert.strictEqual(cards()[0]?.status, 'cancelled');
    assert.strictEqual(server.chatRequests.length, 1);
  });

  it('denies a waiting command when the run is stopped', async () => {
    server.enqueue(command(marker('marker-a.txt')), text('never'));
    await send('marker');
    const card = await pendingCard();
    await api.controller.handleMessage({ type: 'stop' });
    await api.controller.whenIdle();
    assert.strictEqual(existsSync(file('marker-a.txt')), false);
    posted.length = 0;
    await decide(card, 'once');
    assert.strictEqual(existsSync(file('marker-a.txt')), false, 'a late approval does nothing');
    assert.ok(posted.some((m) => m.type === 'toast'));
  });
});
