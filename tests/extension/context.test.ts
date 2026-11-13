import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ByteAgentApi } from '../../src/extension';
import type { HostMessage } from '../../src/shared/protocol';
import { MockServer } from '../mock/mockServer';
import { activate, resetSettings, waitFor } from './helpers';

describe('M3 workspace context', () => {
  const server = new MockServer();
  let api: ByteAgentApi;
  const posted: HostMessage[] = [];
  const root = (): string => vscode.workspace.workspaceFolders![0]!.uri.fsPath;

  before(async () => {
    api = await activate();
    const baseUrl = await server.start();
    await resetSettings();
    await vscode.workspace
      .getConfiguration('byteagent')
      .update('providers', [{ id: 'mock', name: 'Mock', baseUrl, model: 'mock-model', timeoutSeconds: 5 }], vscode.ConfigurationTarget.Global);
    api.controller.attach((m) => posted.push(m));
  });

  beforeEach(async () => {
    server.reset();
    // Revealing the real chat view (as some commands do) replaces the listener.
    api.controller.attach((m) => posted.push(m));
    posted.length = 0;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.controller.newChat();
  });

  after(async () => {
    api.controller.detach();
    await server.stop();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await resetSettings();
  });

  it('sends the relevant workspace file with a question and nothing sensitive', async () => {
    server.enqueue({ type: 'text', text: 'It multiplies two numbers.' });
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'What does the multiply function do?', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();

    const body = JSON.stringify(server.chatRequests[0]?.body);
    assert.ok(body.includes('function multiply(a, b)'), 'math.js content was sent');
    assert.ok(!body.includes('fixture-secret-value-123'), '.env content was not sent');

    const context = api.controller.currentSession.items.find((i) => i.kind === 'context');
    assert.ok(context && context.kind === 'context');
    assert.strictEqual(context.files[0]?.path, 'src/math.js');
    assert.ok(!context.files.some((f) => f.path === '.env'));
    assert.ok(!api.controller.currentSession.items.some((i) => i.kind === 'changes'), 'no diff for a question');
  });

  it('includes unsaved editor text instead of the version on disk', async () => {
    const uri = vscode.Uri.file(path.join(root(), 'src', 'greet.js'));
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '// UNSAVED-MARKER-42\n'));
    try {
      server.enqueue({ type: 'text', text: 'ok' });
      await api.controller.handleMessage({
        type: 'sendPrompt',
        text: 'explain this file',
        mode: 'auto',
        attachments: [{ path: 'src/greet.js', source: 'active' }],
      });
      await api.controller.whenIdle();
      assert.ok(JSON.stringify(server.chatRequests[0]?.body).includes('UNSAVED-MARKER-42'));
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  it('tracks the active file and selection, but never offers a blocked file', async () => {
    const uri = vscode.Uri.file(path.join(root(), 'src', 'math.js'));
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    editor.selection = new vscode.Selection(1, 0, 3, 1);
    await waitFor(() => posted.some((m) => m.type === 'editorContext' && m.editor.selection?.startLine === 2), 'selection reported');
    const state = await api.controller.buildState();
    assert.deepStrictEqual(state.editor, { activeFile: 'src/math.js', selection: { path: 'src/math.js', startLine: 2, endLine: 4 } });

    posted.length = 0;
    await vscode.commands.executeCommand('byteagent.addSelectionToChat');
    const added = posted.find((m) => m.type === 'addAttachment');
    assert.ok(added && added.type === 'addAttachment');
    assert.deepStrictEqual(added.attachment, { path: 'src/math.js', startLine: 2, endLine: 4, source: 'selection' });

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root(), '.env'))));
    assert.deepStrictEqual((await api.controller.buildState()).editor, {}, '.env is never offered as context');
  });

  it('suggests files for @ mentions without blocked files', async () => {
    await api.controller.handleMessage({ type: 'searchFiles', requestId: 'f1', query: 'math' });
    const reply = posted.find((m) => m.type === 'fileSuggestions');
    assert.ok(reply && reply.type === 'fileSuggestions', `no suggestions; webview received: ${JSON.stringify(posted)}`);
    assert.strictEqual(reply.files[0], 'src/math.js');

    posted.length = 0;
    await api.controller.handleMessage({ type: 'searchFiles', requestId: 'f2', query: 'env' });
    const env = posted.find((m) => m.type === 'fileSuggestions');
    assert.ok(env && env.type === 'fileSuggestions' && !env.files.includes('.env'));
  });

  it('asks before sending when confirmation is enabled, and sends nothing if declined', async () => {
    const config = vscode.workspace.getConfiguration('byteagent');
    await config.update('context.confirmBeforeSend', true, vscode.ConfigurationTarget.Global);
    try {
      await api.controller.handleMessage({ type: 'sendPrompt', text: 'What does the add function do?', mode: 'auto', attachments: [] });
      await waitFor(() => api.controller.pendingCount === 1, 'context confirmation shown');
      assert.strictEqual(server.chatRequests.length, 0, 'nothing sent while waiting');
      const item = api.controller.currentSession.items.find((i) => i.kind === 'context');
      assert.ok(item && item.kind === 'context' && item.confirm?.status === 'pending');
      await api.controller.handleMessage({ type: 'contextDecision', requestId: item.confirm.requestId, send: false });
      await api.controller.whenIdle();
      assert.strictEqual(server.chatRequests.length, 0, 'nothing sent after declining');

      server.enqueue({ type: 'text', text: 'It adds.' });
      await api.controller.newChat();
      await api.controller.handleMessage({ type: 'sendPrompt', text: 'What does the add function do?', mode: 'auto', attachments: [] });
      await waitFor(() => api.controller.pendingCount === 1, 'second confirmation shown');
      const second = api.controller.currentSession.items.find((i) => i.kind === 'context');
      assert.ok(second && second.kind === 'context' && second.confirm);
      await api.controller.handleMessage({ type: 'contextDecision', requestId: second.confirm.requestId, send: true });
      await api.controller.whenIdle();
      assert.strictEqual(server.chatRequests.length, 1);
    } finally {
      await config.update('context.confirmBeforeSend', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('answers a waiting confirmation with "do not send" when the run is stopped', async () => {
    const config = vscode.workspace.getConfiguration('byteagent');
    await config.update('context.confirmBeforeSend', true, vscode.ConfigurationTarget.Global);
    try {
      await api.controller.handleMessage({ type: 'sendPrompt', text: 'What does the add function do?', mode: 'auto', attachments: [] });
      await waitFor(() => api.controller.pendingCount === 1, 'confirmation shown');
      await api.controller.handleMessage({ type: 'stop' });
      await api.controller.whenIdle();
      assert.strictEqual(server.chatRequests.length, 0);
      assert.strictEqual(api.controller.pendingCount, 0);
    } finally {
      await config.update('context.confirmBeforeSend', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
