import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { ByteAgentApi } from '../../src/extension';
import type { ChatItem, HostMessage } from '../../src/shared/protocol';
import { MockServer, type MockReply } from '../mock/mockServer';
import { activate, resetSettings } from './helpers';

describe('M6 adaptive execution', () => {
  const server = new MockServer();
  let api: ByteAgentApi;
  const posted: HostMessage[] = [];
  const text = (t: string): MockReply => ({ type: 'text', text: t });
  const items = (): ChatItem[] => api.controller.currentSession.items;
  const classification = () => items().filter((i): i is Extract<ChatItem, { kind: 'classification' }> => i.kind === 'classification');
  const toolNames = (n: number): string[] => (server.chatRequests[n]?.body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);

  before(async () => {
    api = await activate();
    const baseUrl = await server.start();
    await resetSettings();
    await vscode.workspace
      .getConfiguration('byteagent')
      .update('providers', [{ id: 'mock', name: 'Mock', baseUrl, model: 'mock-model', timeoutSeconds: 5, toolCalling: 'native' }], vscode.ConfigurationTarget.Global);
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
    await resetSettings();
  });

  it('classifies a question as Quick and shows why', async () => {
    server.enqueue(text('It adds two numbers.'));
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'What does the add function do?', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();
    assert.strictEqual(classification()[0]?.mode, 'quick');
    assert.strictEqual(classification()[0]?.auto, true);
    assert.ok((classification()[0]?.reasons.length ?? 0) > 0);
    assert.ok(!toolNames(0).includes('update_plan'));
    assert.ok(server.chatRequests[0]?.body.messages[0].content.includes('This is a Quick task'));
  });

  it('classifies a cross-module request as Project, tracks a task and lists it as unfinished', async () => {
    server.enqueue(
      { type: 'tools', calls: [{ name: 'update_plan', arguments: { goal: 'Auth', criteria: ['Login works'], steps: [{ title: 'Inspect', status: 'done' }, { title: 'Build', status: 'in_progress' }] } }] },
      text('Planned. Next: build.'),
    );
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'Add token-based authentication across the API, with login, refresh and protected routes', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();
    assert.strictEqual(classification()[0]?.mode, 'project');
    assert.ok(toolNames(0).includes('update_plan'));
    const plan = items().find((i) => i.kind === 'plan');
    assert.ok(plan && plan.kind === 'plan');
    assert.deepStrictEqual(plan.steps.map((s) => s.status), ['done', 'in_progress']);
    const state = await api.controller.buildState();
    const task = state.tasks.find((t) => t.id === api.controller.currentSession.taskId);
    assert.ok(task, 'task is listed as unfinished');
    assert.deepStrictEqual([task.mode, task.status, task.stepsDone, task.stepsTotal], ['project', 'paused', 1, 2]);
  });

  it('honours the mode chosen in the UI', async () => {
    server.enqueue(text('ok'));
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'What does the add function do?', mode: 'standard', attachments: [] });
    await api.controller.whenIdle();
    assert.strictEqual(classification()[0]?.mode, 'standard');
    assert.strictEqual(classification()[0]?.auto, false);
    assert.ok(toolNames(0).includes('update_plan'));
  });

  it('remembers the default mode setting', async () => {
    await api.controller.handleMessage({ type: 'setMode', mode: 'project' });
    assert.strictEqual((await api.controller.buildState()).defaultMode, 'project');
    await api.controller.handleMessage({ type: 'setMode', mode: 'auto' });
    assert.strictEqual((await api.controller.buildState()).defaultMode, 'auto');
  });
});
