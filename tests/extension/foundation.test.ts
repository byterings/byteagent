import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { HostMessage } from '../../src/shared/protocol';
import { activate, EXTENSION_ID, resetSettings } from './helpers';

describe('M1 foundation', () => {
  beforeEach(resetSettings);
  after(resetSettings);

  it('activates in the extension host', async () => {
    const api = await activate();
    assert.ok(api.services, 'services are exposed');
    assert.ok(vscode.extensions.getExtension(EXTENSION_ID)?.isActive);
  });

  it('registers every contributed command', async () => {
    await activate();
    const contributed: Array<{ command: string }> =
      vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.contributes.commands ?? [];
    assert.ok(contributed.length >= 8);
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.map((c) => c.command).filter((c) => !registered.has(c));
    assert.deepStrictEqual(missing, []);
  });

  it('reads and validates configuration, reporting bad profiles instead of failing', async () => {
    const api = await activate();
    const config = vscode.workspace.getConfiguration('byteagent');
    await config.update(
      'providers',
      [
        { id: 'ok', name: 'OK', baseUrl: 'http://localhost:9/v1/', model: 'm' },
        { id: 'broken', name: 'Broken', baseUrl: 'ftp://nope', model: 'm' },
      ],
      vscode.ConfigurationTarget.Global,
    );
    const { settings, problems } = api.services.settings();
    assert.strictEqual(settings.providers.length, 1);
    assert.strictEqual(settings.providers[0]?.baseUrl, 'http://localhost:9/v1');
    assert.strictEqual(settings.activeProvider, 'ok');
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0]?.setting ?? '', /providers\[1\]/);
  });

  it('stores, reads and deletes an API key through SecretStorage only', async () => {
    const api = await activate();
    const key = 'test-key-9f8e7d6c5b4a';
    await api.services.secrets.setApiKey('ok', key);
    assert.strictEqual(await api.services.secrets.getApiKey('ok'), key);
    assert.strictEqual(await api.services.secrets.hasApiKey('ok'), true);

    const config = vscode.workspace.getConfiguration('byteagent');
    assert.ok(!JSON.stringify(config.inspect('providers')).includes(key), 'key is not in settings');
    assert.strictEqual(api.services.redactor.redact(`using ${key}`).includes(key), false, 'key is redacted');

    await api.services.secrets.deleteApiKey('ok');
    assert.strictEqual(await api.services.secrets.getApiKey('ok'), undefined);
  });

  it('saves a profile from the webview protocol and never sends the key back', async () => {
    const api = await activate();
    const posted: HostMessage[] = [];
    api.controller.attach((m) => posted.push(m));
    try {
      await api.controller.handleMessage({
        type: 'saveProfile',
        requestId: 'r1',
        draft: { id: '', name: 'Local Test', baseUrl: 'localhost:9/v1', model: 'm1' },
        apiKey: 'webview-key-11223344',
        makeActive: true,
      });
      const saved = posted.find((m) => m.type === 'profileSaved');
      assert.ok(saved && saved.type === 'profileSaved' && saved.ok, 'profile saved');
      const state = posted.filter((m) => m.type === 'state').pop();
      assert.ok(state && state.type === 'state');
      assert.strictEqual(state.state.profiles[0]?.id, 'local-test');
      assert.strictEqual(state.state.profiles[0]?.hasKey, true);
      assert.strictEqual(state.state.activeProfileId, 'local-test');
      assert.ok(!JSON.stringify(posted).includes('webview-key-11223344'), 'key never posted to the webview');
      assert.strictEqual(await api.services.secrets.getApiKey('local-test'), 'webview-key-11223344');

      posted.length = 0;
      await api.controller.handleMessage({
        type: 'saveProfile',
        requestId: 'r2',
        draft: { id: '', name: 'Bad', baseUrl: 'ftp://x', model: '' },
        makeActive: true,
      });
      const failed = posted.find((m) => m.type === 'profileSaved');
      assert.ok(failed && failed.type === 'profileSaved' && !failed.ok);
      assert.deepStrictEqual(failed.errors.map((e) => e.field).sort(), ['baseUrl', 'model']);
    } finally {
      await api.controller.handleMessage({ type: 'deleteProfile', id: 'local-test' });
      api.controller.detach();
    }
    assert.strictEqual(await api.services.secrets.getApiKey('local-test'), undefined, 'key deleted with profile');
  });

  it('opens the chat view without errors', async () => {
    await activate();
    await vscode.commands.executeCommand('byteagent.openChat');
    await vscode.commands.executeCommand('byteagent.openSettings');
  });
});
