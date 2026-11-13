import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { ByteAgentApi } from '../../src/extension';
import type { ChatItem, HostMessage } from '../../src/shared/protocol';
import { MockServer } from '../mock/mockServer';
import { activate, resetSettings, waitFor } from './helpers';

describe('M2 streaming chat', () => {
  const server = new MockServer();
  let api: ByteAgentApi;
  const posted: HostMessage[] = [];

  before(async () => {
    api = await activate();
    const baseUrl = await server.start();
    await resetSettings();
    await vscode.workspace
      .getConfiguration('byteagent')
      .update('providers', [{ id: 'mock', name: 'Mock', baseUrl, model: 'mock-model', timeoutSeconds: 5 }], vscode.ConfigurationTarget.Global);
    await api.services.secrets.setApiKey('mock', 'mock-key-abcdef123456');
    api.controller.attach((m) => posted.push(m));
  });

  beforeEach(async () => {
    server.reset();
    api.controller.attach((m) => posted.push(m));
    posted.length = 0;
    await api.controller.newChat();
  });

  after(async () => {
    api.controller.detach();
    await server.stop();
    await api.services.secrets.deleteApiKey('mock');
    await resetSettings();
  });

  const items = (): ChatItem[] => api.controller.currentSession.items;

  it('sends a prompt to the configured endpoint and streams the reply to the webview', async () => {
    server.enqueue({ type: 'text', text: 'Hello from the mock provider.', chunkSize: 3 });
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'Say hello', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();

    assert.strictEqual(server.chatRequests.length, 1);
    assert.strictEqual(server.chatRequests[0]?.headers.authorization, 'Bearer mock-key-abcdef123456');
    assert.strictEqual(server.chatRequests[0]?.body.model, 'mock-model');

    const assistant = items().find((i) => i.kind === 'assistant');
    assert.ok(assistant && assistant.kind === 'assistant');
    assert.strictEqual(assistant.text, 'Hello from the mock provider.');
    assert.strictEqual(assistant.streaming, false);

    const deltas = posted.filter((m) => m.type === 'textDelta');
    assert.ok(deltas.length >= 1, 'text reached the webview as deltas');
    assert.strictEqual(deltas.map((d) => (d.type === 'textDelta' ? d.delta : '')).join(''), 'Hello from the mock provider.');
    assert.ok(posted.some((m) => m.type === 'busy' && m.busy), 'busy on');
    assert.ok(posted.some((m) => m.type === 'busy' && !m.busy), 'busy off');
    assert.ok(!JSON.stringify(posted).includes('mock-key-abcdef123456'), 'key never reaches the webview');
  });

  it('keeps conversation context across turns and saves the session', async () => {
    server.enqueue({ type: 'text', text: 'first answer' }, { type: 'text', text: 'second answer' });
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'first question', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'second question', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();

    const second = server.chatRequests[1]?.body.messages.map((m: { content: string }) => m.content);
    assert.ok(second.includes('first question') && second.includes('first answer'));

    const state = await api.controller.buildState();
    assert.strictEqual(state.sessions[0]?.title, 'first question');
    assert.strictEqual(state.sessions[0]?.messageCount, 2);
  });

  it('stops a running reply on request', async () => {
    server.enqueue({ type: 'text', text: 'slow '.repeat(300), chunkSize: 5, delayMs: 15 });
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'long answer please', mode: 'auto', attachments: [] });
    await waitFor(() => items().some((i) => i.kind === 'assistant' && i.text.length > 10), 'first text');
    assert.strictEqual(api.controller.isBusy, true);
    await api.controller.handleMessage({ type: 'stop' });
    await api.controller.whenIdle();
    assert.strictEqual(api.controller.isBusy, false);
    const assistant = items().find((i) => i.kind === 'assistant');
    assert.ok(assistant && assistant.kind === 'assistant' && assistant.text.length < 1400);
    assert.ok(items().some((i) => i.kind === 'notice' && i.text === 'Stopped.'));
  });

  it('shows provider errors without crashing and can retry', async () => {
    server.enqueue({ type: 'error', status: 500, body: { error: { message: 'boom' } } }, { type: 'error', status: 500 }, { type: 'error', status: 500 });
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'will fail', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();
    const error = items().find((i) => i.kind === 'error');
    assert.ok(error && error.kind === 'error' && error.code === 'server' && error.canRetry);

    server.enqueue({ type: 'text', text: 'recovered' });
    await api.controller.handleMessage({ type: 'retry' });
    await api.controller.whenIdle();
    assert.deepStrictEqual(items().map((i) => i.kind).filter((k) => k !== 'context' && k !== 'classification'), ['user', 'assistant']);
    assert.ok(items().some((i) => i.kind === 'assistant' && i.text === 'recovered'));
  });

  it('ignores a second prompt while one is running', async () => {
    server.enqueue({ type: 'text', text: 'x'.repeat(200), chunkSize: 10, delayMs: 10 });
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'one', mode: 'auto', attachments: [] });
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'two', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();
    assert.strictEqual(items().filter((i) => i.kind === 'user').length, 1);
    assert.strictEqual(server.chatRequests.length, 1);
  });

  it('tests the connection and lists models through the webview protocol', async () => {
    server.enqueue({ type: 'text', text: 'ok' });
    const draft = { id: 'mock', name: 'Mock', baseUrl: server.baseUrl, model: 'mock-model' };
    await api.controller.handleMessage({ type: 'testConnection', requestId: 't1', draft });
    const result = posted.find((m) => m.type === 'connectionResult');
    assert.ok(result && result.type === 'connectionResult' && result.ok, 'connection ok');

    await api.controller.handleMessage({ type: 'listModels', requestId: 'm1', draft });
    const models = posted.find((m) => m.type === 'models');
    assert.ok(models && models.type === 'models');
    assert.deepStrictEqual(models.models, ['mock-model', 'mock-model-small']);

    await api.controller.handleMessage({ type: 'testConnection', requestId: 't2', draft: { ...draft, baseUrl: 'http://127.0.0.1:9/v1' } });
    const failed = posted.filter((m) => m.type === 'connectionResult').pop();
    assert.ok(failed && failed.type === 'connectionResult' && !failed.ok);
  });

  it('tells the user to add a provider when none is configured', async () => {
    const config = vscode.workspace.getConfiguration('byteagent');
    const saved = config.get('providers');
    await config.update('providers', [], vscode.ConfigurationTarget.Global);
    try {
      await api.controller.handleMessage({ type: 'sendPrompt', text: 'hello', mode: 'auto', attachments: [] });
      await api.controller.whenIdle();
      const error = items().find((i) => i.kind === 'error');
      assert.ok(error && error.kind === 'error' && error.code === 'no_provider' && error.openSettings);
      assert.strictEqual(server.chatRequests.length, 0);
    } finally {
      await config.update('providers', saved, vscode.ConfigurationTarget.Global);
    }
  });
});
