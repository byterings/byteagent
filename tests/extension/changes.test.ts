import * as assert from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ByteAgentApi } from '../../src/extension';
import type { ChatItem, HostMessage } from '../../src/shared/protocol';
import { MockServer, type MockReply } from '../mock/mockServer';
import { activate, resetSettings, waitFor } from './helpers';

type ChangesItem = Extract<ChatItem, { kind: 'changes' }>;

describe('M4 change review', () => {
  const server = new MockServer();
  let api: ByteAgentApi;
  const posted: HostMessage[] = [];
  const root = (): string => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const file = (rel: string): string => path.join(root(), rel);
  const read = (rel: string): string => readFileSync(file(rel), 'utf8');
  const MATH = 'src/math.js';
  let originalMath = '';
  let originalGreet = '';

  const propose = (changes: unknown[], summary = 'Test change'): MockReply => ({ type: 'tools', calls: [{ name: 'propose_changes', arguments: { summary, changes } }] });
  const renameAdd = [{ path: MATH, action: 'edit', edits: [{ search: 'function add(a, b)', replace: 'function add(x, y)' }, { search: 'return a + b;', replace: 'return x + y;' }] }];

  const pendingCard = async (): Promise<ChangesItem> => {
    await waitFor(() => api.controller.currentSession.items.some((i) => i.kind === 'changes' && i.status === 'pending'), 'review card shown');
    return api.controller.currentSession.items.find((i): i is ChangesItem => i.kind === 'changes' && i.status === 'pending')!;
  };
  const lastCard = (): ChangesItem => api.controller.currentSession.items.filter((i): i is ChangesItem => i.kind === 'changes').pop()!;
  const decide = (card: ChangesItem, decision: 'accept' | 'reject', feedback?: string) =>
    api.controller.handleMessage({
      type: 'reviewDecision',
      changeSetId: card.changeSetId,
      decisions: Object.fromEntries(card.files.map((f) => [f.changeId, decision])),
      feedback,
    });
  const send = (text: string) => api.controller.handleMessage({ type: 'sendPrompt', text, mode: 'auto', attachments: [] });

  before(async () => {
    api = await activate();
    const baseUrl = await server.start();
    await resetSettings();
    await vscode.workspace
      .getConfiguration('byteagent')
      .update('providers', [{ id: 'mock', name: 'Mock', baseUrl, model: 'mock-model', timeoutSeconds: 5, toolCalling: 'native' }], vscode.ConfigurationTarget.Global);
    originalMath = read(MATH);
    originalGreet = read('src/greet.js');
  });

  beforeEach(async () => {
    server.reset();
    api.controller.attach((m) => posted.push(m));
    posted.length = 0;
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    writeFileSync(file(MATH), originalMath);
    writeFileSync(file('src/greet.js'), originalGreet);
    await api.controller.newChat();
  });

  after(async () => {
    api.controller.detach();
    await server.stop();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    writeFileSync(file(MATH), originalMath);
    await resetSettings();
  });

  it('writes nothing while a proposal waits, then applies it on accept', async () => {
    server.enqueue(propose(renameAdd), { type: 'text', text: 'Renamed the parameters.' });
    await send('rename the parameters of add');
    const card = await pendingCard();

    assert.strictEqual(api.controller.isBusy, true, 'run waits for the review');
    assert.strictEqual(read(MATH), originalMath, 'nothing written before approval');
    assert.deepStrictEqual(card.files.map((f) => [f.path, f.kind, f.added, f.removed, f.status]), [[MATH, 'modify', 2, 2, 'pending']]);
    assert.strictEqual(server.chatRequests.length, 1, 'the model is not called again before the decision');

    await decide(card, 'accept');
    await api.controller.whenIdle();

    assert.ok(read(MATH).includes('function add(x, y)') && read(MATH).includes('return x + y;'));
    assert.strictEqual(lastCard().files[0]?.status, 'applied');
    const toolResult = server.chatRequests[1]?.body.messages.find((m: { role: string }) => m.role === 'tool');
    assert.ok(toolResult.content.includes('APPLIED: src/math.js'));
  });

  it('leaves the file untouched on reject (Scenario F)', async () => {
    server.enqueue(propose(renameAdd), { type: 'text', text: 'Okay, no changes.' });
    await send('rename the parameters of add');
    await decide(await pendingCard(), 'reject');
    await api.controller.whenIdle();
    assert.strictEqual(read(MATH), originalMath);
    assert.strictEqual(lastCard().files[0]?.status, 'rejected');
    assert.ok(server.chatRequests[1]?.body.messages.some((m: { role: string; content: string }) => m.role === 'tool' && m.content.includes('rejected by the user')));
  });

  it('treats unknown ids and odd values in a decision as rejections', async () => {
    server.enqueue(propose(renameAdd), { type: 'text', text: 'ok' });
    await send('rename');
    const card = await pendingCard();
    await api.controller.handleMessage({
      type: 'reviewDecision',
      changeSetId: card.changeSetId,
      decisions: { 'not-a-real-id': 'accept', [card.files[0]!.changeId]: 'yes please' as unknown as 'accept' },
    });
    await api.controller.whenIdle();
    assert.strictEqual(read(MATH), originalMath);
  });

  it('sends revision feedback to the model and applies nothing from that proposal', async () => {
    server.enqueue(propose(renameAdd), { type: 'text', text: 'What names would you like?' });
    await send('rename');
    await decide(await pendingCard(), 'accept', 'Use first and second instead');
    await api.controller.whenIdle();
    assert.strictEqual(read(MATH), originalMath, 'feedback never applies the proposal it comments on');
    assert.strictEqual(lastCard().feedback, 'Use first and second instead');
    assert.ok(server.chatRequests[1]?.body.messages.some((m: { role: string; content: string }) => m.role === 'tool' && m.content.includes('Use first and second instead')));
  });

  it('applies through an open editor and keeps the tab in sync', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file(MATH)));
    await vscode.window.showTextDocument(document);
    server.enqueue(propose(renameAdd), { type: 'text', text: 'done' });
    await send('rename');
    await decide(await pendingCard(), 'accept');
    await api.controller.whenIdle();
    assert.strictEqual(lastCard().files[0]?.status, 'applied');
    assert.ok(read(MATH).includes('function add(x, y)'));
    await waitFor(() => document.getText().includes('function add(x, y)'), 'open tab reloads the new content');
    assert.strictEqual(document.isDirty, false);
  });

  it('applies on top of unsaved editor text when that text was the reviewed base', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file(MATH)));
    const editor = await vscode.window.showTextDocument(document);
    await waitFor(() => document.getText() === originalMath, 'editor shows the file on disk');
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// unsaved note\n'));
    server.enqueue(propose(renameAdd), { type: 'text', text: 'done' });
    await send('rename');
    await decide(await pendingCard(), 'accept');
    await api.controller.whenIdle();
    assert.strictEqual(lastCard().files[0]?.status, 'applied');
    assert.ok(read(MATH).startsWith('// unsaved note\n'), 'the unsaved note was kept and saved');
    assert.ok(read(MATH).includes('function add(x, y)'));
    assert.strictEqual(document.isDirty, false, 'document was saved');
  });

  it('refuses to overwrite unsaved editor changes made after the preview (Scenario G)', async () => {
    server.enqueue(propose(renameAdd), { type: 'text', text: 'The file changed; please review again.' });
    await send('rename');
    const card = await pendingCard();

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file(MATH)));
    const editor = await vscode.window.showTextDocument(document);
    // VS Code may still hold an older copy from an earlier test until it reloads.
    await waitFor(() => document.getText() === originalMath, 'editor shows the file on disk');
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// typed while the preview was open\n'));
    assert.strictEqual(document.isDirty, true);

    await decide(card, 'accept');
    await api.controller.whenIdle();

    assert.strictEqual(lastCard().files[0]?.status, 'stale');
    assert.match(lastCard().files[0]?.error ?? '', /changed after this preview/);
    assert.ok(document.getText().startsWith('// typed while the preview was open'), 'the user’s unsaved text is intact');
    assert.ok(!document.getText().includes('function add(x, y)'));
    assert.strictEqual(read(MATH), originalMath, 'disk untouched');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('refuses to overwrite a file changed on disk after the preview', async () => {
    server.enqueue(propose(renameAdd), { type: 'text', text: 'ok' });
    await send('rename');
    const card = await pendingCard();
    writeFileSync(file(MATH), `${originalMath}\n// appended by another tool\n`);
    await decide(card, 'accept');
    await api.controller.whenIdle();
    assert.strictEqual(lastCard().files[0]?.status, 'stale');
    assert.ok(read(MATH).endsWith('// appended by another tool\n'));
    assert.ok(!read(MATH).includes('function add(x, y)'));
  });

  it('creates, modifies and deletes several files, applying only accepted ones', async () => {
    writeFileSync(file('src/old.js'), 'module.exports = 1;\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    server.enqueue(
      propose([
        { path: 'src/greet.js', action: 'edit', edits: [{ search: 'Hello', replace: 'Hi' }] },
        { path: 'src/new/util.js', action: 'write', content: 'module.exports = {};\n' },
        { path: 'src/old.js', action: 'delete' },
      ]),
      { type: 'text', text: 'done' },
    );
    await send('several');
    const card = await pendingCard();
    assert.deepStrictEqual(card.files.map((f) => f.kind), ['modify', 'create', 'delete']);
    const [greet, util, old] = card.files;
    await api.controller.handleMessage({
      type: 'reviewDecision',
      changeSetId: card.changeSetId,
      decisions: { [greet!.changeId]: 'reject', [util!.changeId]: 'accept', [old!.changeId]: 'accept' },
    });
    await api.controller.whenIdle();
    assert.deepStrictEqual(lastCard().files.map((f) => f.status), ['rejected', 'applied', 'applied']);
    assert.strictEqual(read('src/greet.js'), originalGreet);
    assert.strictEqual(read('src/new/util.js'), 'module.exports = {};\n');
    assert.strictEqual(existsSync(file('src/old.js')), false);
  });

  it('opens the proposed change in the diff editor', async () => {
    server.enqueue(propose(renameAdd), { type: 'text', text: 'ok' });
    await send('rename');
    const card = await pendingCard();
    await api.controller.handleMessage({ type: 'openDiff', changeSetId: card.changeSetId, changeId: card.files[0]!.changeId });
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'byteagent-review', 'diff editor opened');
    const proposed = vscode.window.activeTextEditor!.document.getText();
    assert.ok(proposed.includes('function add(x, y)'), 'right side shows the proposed content');
    assert.strictEqual(read(MATH), originalMath, 'viewing the diff changes nothing');
    await decide(card, 'reject');
    await api.controller.whenIdle();
  });

  it('applies nothing when the run is stopped during review', async () => {
    server.enqueue(propose(renameAdd), { type: 'text', text: 'never' });
    await send('rename');
    const card = await pendingCard();
    await api.controller.handleMessage({ type: 'stop' });
    await api.controller.whenIdle();
    assert.strictEqual(read(MATH), originalMath);
    assert.strictEqual(lastCard().status, 'resolved');
    assert.strictEqual(lastCard().files[0]?.status, 'rejected');

    posted.length = 0;
    await decide(card, 'accept');
    assert.strictEqual(read(MATH), originalMath, 'a late decision for a finished review does nothing');
    assert.ok(posted.some((m) => m.type === 'toast'));
  });

  it('never proposes or applies changes to blocked files', async () => {
    server.enqueue(propose([{ path: '.env', action: 'write', content: 'SECRET_TOKEN=overwritten\n' }]), { type: 'text', text: 'I cannot change that file.' });
    await send('change the env file');
    await api.controller.whenIdle();
    assert.ok(!api.controller.currentSession.items.some((i) => i.kind === 'changes'), 'no review card for a blocked file');
    assert.ok(read('.env').includes('fixture-secret-value-123'));
  });
});
