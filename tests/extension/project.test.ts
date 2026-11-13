import * as assert from 'node:assert';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ByteAgentApi } from '../../src/extension';
import type { ChatItem, HostMessage } from '../../src/shared/protocol';
import { MockServer, type MockReply } from '../mock/mockServer';
import { activate, resetSettings, waitFor } from './helpers';

type ChangesItem = Extract<ChatItem, { kind: 'changes' }>;

describe('M7 project knowledge, persistence and resume', () => {
  const serverA = new MockServer();
  const serverB = new MockServer();
  let api: ByteAgentApi;
  const posted: HostMessage[] = [];
  const root = (): string => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const file = (rel: string): string => path.join(root(), rel);
  const read = (rel: string): string => readFileSync(file(rel), 'utf8');
  const items = (): ChatItem[] => api.controller.currentSession.items;
  const text = (t: string): MockReply => ({ type: 'text', text: t });
  const tools = (...calls: Array<{ name: string; arguments: unknown }>): MockReply => ({ type: 'tools', calls });
  const seenCards = new Set<string>();
  /** Waits for a review card that has not been handed out before. */
  const pendingCard = async (): Promise<ChangesItem> => {
    const find = (): ChangesItem | undefined =>
      items().find((i): i is ChangesItem => i.kind === 'changes' && i.status === 'pending' && !seenCards.has(i.changeSetId));
    await waitFor(() => find() !== undefined, 'review card shown');
    const card = find()!;
    seenCards.add(card.changeSetId);
    return card;
  };
  const decide = (card: ChangesItem, decision: 'accept' | 'reject') =>
    api.controller.handleMessage({ type: 'reviewDecision', changeSetId: card.changeSetId, decisions: Object.fromEntries(card.files.map((f) => [f.changeId, decision])) });
  const useProvider = async (id: string) => vscode.workspace.getConfiguration('byteagent').update('activeProvider', id, vscode.ConfigurationTarget.Global);
  const PROMPT = 'Add token-based authentication across the API, with login, refresh and protected routes';
  let readmeBefore = '';

  before(async () => {
    api = await activate();
    const urlA = await serverA.start();
    const urlB = await serverB.start();
    await resetSettings();
    await vscode.workspace.getConfiguration('byteagent').update(
      'providers',
      [
        { id: 'mock-a', name: 'Mock A', baseUrl: urlA, model: 'model-a', timeoutSeconds: 5, toolCalling: 'native' },
        { id: 'mock-b', name: 'Mock B', baseUrl: urlB, model: 'model-b', timeoutSeconds: 5, toolCalling: 'native' },
      ],
      vscode.ConfigurationTarget.Global,
    );
    await useProvider('mock-a');
    writeFileSync(file('README.md'), '# Fixture app\n\nA tiny project used by the tests.\n');
    readmeBefore = read('README.md');
    await api.controller.ready();
  });

  beforeEach(async () => {
    serverA.reset();
    serverB.reset();
    api.controller.attach((m) => posted.push(m));
    posted.length = 0;
    await api.controller.newChat();
  });

  after(async () => {
    api.controller.detach();
    await serverA.stop();
    await serverB.stop();
    await api.controller.reloadStore().catch(() => undefined);
    rmSync(file('.byteagent'), { recursive: true, force: true });
    rmSync(file('README.md'), { force: true });
    rmSync(file('src/auth'), { recursive: true, force: true });
    await api.controller.reloadStore().catch(() => undefined);
    await resetSettings();
  });

  it('keeps its database outside the project until project knowledge is set up', async () => {
    assert.strictEqual(existsSync(file('.byteagent')), false);
    const store = api.controller.projectStore;
    assert.ok(store, 'a store is available');
    assert.ok(!store.path.startsWith(root()), `database is outside the workspace: ${store.path}`);
    assert.strictEqual((await api.controller.buildState()).projectInitialized, false);
  });

  it('writes nothing when the proposed knowledge files are rejected', async () => {
    await api.controller.initProject();
    const card = await pendingCard();
    assert.deepStrictEqual(card.files.map((f) => [f.path, f.kind]), [
      ['.byteagent/.gitignore', 'create'],
      ['.byteagent/context.md', 'create'],
      ['.byteagent/decisions.md', 'create'],
      ['.byteagent/project_status.md', 'create'],
      ['.byteagent/roadmap.md', 'create'],
    ]);
    assert.strictEqual(existsSync(file('.byteagent')), false, 'nothing exists before the decision');
    await decide(card, 'reject');
    await api.controller.whenIdle();
    assert.strictEqual(existsSync(file('.byteagent')), false);
    assert.ok(!api.controller.projectStore!.path.startsWith(root()), 'database stays outside the project');
    assert.strictEqual(serverA.chatRequests.length, 0, 'onboarding does not call the provider');
  });

  it('scans an existing project and creates the knowledge files after approval', async () => {
    await vscode.commands.executeCommand('byteagent.initProject', { includeAgentsFile: false });
    const card = await pendingCard();
    const summary = items().find((i) => i.kind === 'assistant');
    assert.ok(summary && summary.kind === 'assistant');
    assert.match(summary.text, /Test command found: `npm test`\. I have not run it\./);
    assert.match(summary.text, /`README\.md`\) are left untouched/);

    await decide(card, 'accept');
    await api.controller.whenIdle();

    const context = read('.byteagent/context.md');
    assert.ok(context.includes('## Discovered facts') && context.includes('## Inferences') && context.includes('## Unknown'));
    assert.ok(context.includes('Test command: `npm test`. Source: project manifest.'));
    assert.ok(context.includes('Whether the tests currently pass: they have not been run by ByteAgent.'));
    assert.ok(read('.byteagent/roadmap.md').includes('ByteAgent has not invented one'));
    assert.ok(read('.byteagent/project_status.md').includes('Nothing yet. ByteAgent has not run any test'));
    assert.ok(read('.byteagent/.gitignore').includes('agent.db'));
    assert.strictEqual(read('README.md'), readmeBefore, 'existing documents are untouched');
    assert.strictEqual(existsSync(file('AGENTS.md')), false, 'AGENTS.md is not created unless asked for');

    const store = api.controller.projectStore!;
    assert.strictEqual(store.path, file('.byteagent/agent.db'), 'database moved into the approved folder');
    await store.flush();
    assert.ok(existsSync(file('.byteagent/agent.db')));
    assert.ok(store.fileCount() > 0, 'file index stored');
    assert.deepStrictEqual(store.findSymbols('multiply').map((sym) => [sym.path, sym.kind]), [['src/math.js', 'function']], 'declared names stored');
    assert.strictEqual((await api.controller.buildState()).projectInitialized, true);

    const outcome = items().find((i) => i.kind === 'outcome');
    assert.ok(outcome && outcome.kind === 'outcome');
    assert.strictEqual(outcome.outcome.applied.length, 5);
    assert.strictEqual(outcome.outcome.verification, 'not_run');
  });

  it('does nothing on a second setup and never overwrites edited knowledge', async () => {
    writeFileSync(file('.byteagent/context.md'), `${read('.byteagent/context.md')}\n- Orders are stored in memory only. (added by the developer)\n`);
    const edited = read('.byteagent/context.md');
    await api.controller.initProject();
    await api.controller.whenIdle();
    assert.ok(!items().some((i) => i.kind === 'changes'), 'no review card when nothing is missing');
    const summary = items().find((i) => i.kind === 'assistant');
    assert.ok(summary && summary.kind === 'assistant' && summary.text.includes('Project knowledge is already set up.'));
    assert.strictEqual(read('.byteagent/context.md'), edited);
  });

  it('gives the model the project knowledge without the developer repeating it', async () => {
    serverA.enqueue(text('In memory only.'));
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'Where are orders stored?', mode: 'auto', attachments: [] });
    await api.controller.whenIdle();
    const system = serverA.chatRequests[0]?.body.messages[0].content as string;
    assert.ok(system.includes('Project knowledge from .byteagent/context.md'));
    assert.ok(system.includes('Orders are stored in memory only. (added by the developer)'));
    assert.ok(!items().some((i) => i.kind === 'changes'), 'a simple question generates no documents');
  });

  let taskId = '';

  it('tracks a project task and offers to update only the task section of the status document', async () => {
    writeFileSync(file('.byteagent/project_status.md'), read('.byteagent/project_status.md').replace('## Not verified', 'Handwritten note that must survive.\n\n## Not verified'));
    serverA.enqueue(
      tools({ name: 'update_plan', arguments: { goal: 'Token authentication', criteria: ['Login returns tokens'], steps: [{ id: '1', title: 'Add token service', status: 'in_progress' }, { id: '2', title: 'Protect routes' }] } }),
      tools({ name: 'propose_changes', arguments: { summary: 'Token service', changes: [{ path: 'src/auth/token.js', action: 'write', content: "module.exports = { sign: (id) => 'token-' + id };\n" }] } }),
      tools({ name: 'update_plan', arguments: { steps: [{ id: '1', title: 'Add token service', status: 'done' }, { id: '2', title: 'Protect routes', status: 'in_progress' }] } }),
      text('Token service added. Protecting routes is next.'),
    );
    await api.controller.handleMessage({ type: 'sendPrompt', text: PROMPT, mode: 'auto', attachments: [] });
    await decide(await pendingCard(), 'accept');

    // After the run, the status document update is proposed like any other change.
    const sync = await pendingCard();
    assert.deepStrictEqual(sync.files.map((f) => [f.path, f.kind]), [['.byteagent/project_status.md', 'modify']]);
    assert.ok(!read('.byteagent/project_status.md').includes('Token authentication'), 'not written before approval');
    await decide(sync, 'accept');
    await api.controller.whenIdle();

    const status = read('.byteagent/project_status.md');
    assert.ok(status.includes('### Token authentication'));
    assert.ok(status.includes('- Status: paused (1 of 2 steps done)'));
    assert.ok(status.includes('  - [x] Add token service'));
    assert.ok(status.includes('- Checks run: none recorded'));
    assert.ok(status.includes('Handwritten note that must survive.'));
    assert.ok(status.includes('Nothing yet. ByteAgent has not run any test'));

    taskId = api.controller.currentSession.taskId ?? '';
    assert.ok(taskId);
    const events = api.controller.projectStore!.events({ taskId });
    assert.deepStrictEqual(events.map((e) => e.type), ['run', 'changes_applied']);
    assert.deepStrictEqual(events[0]?.data.providerId, 'mock-a');
  });

  it('lists the unfinished task after a restart and resumes it with another provider (Scenarios D and E)', async () => {
    await api.controller.reloadStore(); // the database is closed and read again from disk
    const state = await api.controller.buildState();
    const task = state.tasks.find((t) => t.id === taskId);
    assert.ok(task, 'unfinished task is listed after reload');
    assert.deepStrictEqual([task.title, task.status, task.stepsDone, task.stepsTotal], ['Token authentication', 'paused', 1, 2]);

    await useProvider('mock-b');
    serverB.enqueue(
      tools({ name: 'update_plan', arguments: { steps: [{ id: '1', title: 'Add token service', status: 'done' }, { id: '2', title: 'Protect routes', status: 'done' }] } }),
      text('Both steps are done.'),
    );
    const previousSession = api.controller.currentSession.id;
    await api.controller.handleMessage({ type: 'resumeTask', taskId });
    // The finished task changes the status document again.
    await decide(await pendingCard(), 'accept');
    await api.controller.whenIdle();

    assert.strictEqual(serverA.chatRequests.length, 0, 'the old provider is not contacted');
    assert.strictEqual(serverB.chatRequests[0]?.body.model, 'model-b');
    const messages = serverB.chatRequests[0]?.body.messages as Array<{ role: string; content: string }>;
    assert.deepStrictEqual(messages.map((m) => m.role), ['system', 'user'], 'no earlier conversation is replayed');
    assert.ok(messages[1]?.content.includes('You are continuing a saved task.'));
    assert.ok(messages[1]?.content.includes('- [done] (1) Add token service'));
    assert.ok(messages[1]?.content.includes('Files this task has changed so far: src/auth/token.js'));
    assert.ok(!JSON.stringify(messages).includes('Token service added. Protecting routes is next.'));

    // An empty conversation is reused; one with content is never mixed with the resumed task.
    assert.strictEqual(api.controller.currentSession.id, previousSession);
    assert.deepStrictEqual(items()[0], { ...items()[0], kind: 'user', text: 'Continue this task.' });
    assert.strictEqual(api.controller.currentSession.title, 'Resume: Token authentication');
    assert.strictEqual(api.controller.currentSession.taskId, taskId, 'same task id');

    const store = api.controller.projectStore!;
    assert.strictEqual(store.get(taskId)?.status, 'done');
    assert.deepStrictEqual(store.events({ taskId }).filter((e) => e.type === 'run').map((e) => e.data.providerId), ['mock-a', 'mock-b']);
    assert.ok(!(await api.controller.buildState()).tasks.some((t) => t.id === taskId), 'finished task is no longer listed as open');
    assert.ok(read('.byteagent/project_status.md').includes('- Status: done (2 of 2 steps done)'));
    await useProvider('mock-a');
  });

  it('starts a new conversation when resuming from one that already has content', async () => {
    serverA.enqueue(tools({ name: 'update_plan', arguments: { goal: 'Second task', steps: [{ title: 'Only step', status: 'in_progress' }] } }), text('Planned.'));
    await api.controller.handleMessage({ type: 'sendPrompt', text: 'Migrate the project from JavaScript to TypeScript', mode: 'auto', attachments: [] });
    await decide(await pendingCard(), 'reject'); // decline the status document update
    await api.controller.whenIdle();
    const second = api.controller.currentSession.taskId!;
    const before = api.controller.currentSession.id;
    assert.ok(items().length > 0);

    serverA.enqueue(text('Continuing.'));
    await api.controller.handleMessage({ type: 'resumeTask', taskId: second });
    await api.controller.whenIdle();
    assert.notStrictEqual(api.controller.currentSession.id, before, 'a new conversation was started');
    assert.strictEqual(api.controller.currentSession.title, 'Resume: Second task');
    assert.ok(!items().some((i) => i.kind === 'changes'), 'a declined status update is not offered again while nothing changed');
    assert.strictEqual(api.controller.projectStore!.get(second)?.status, 'paused');
  });

  it('refuses to resume a finished or unknown task', async () => {
    posted.length = 0;
    await api.controller.handleMessage({ type: 'resumeTask', taskId });
    await api.controller.handleMessage({ type: 'resumeTask', taskId: 'task_does_not_exist' });
    await api.controller.whenIdle();
    assert.strictEqual(posted.filter((m) => m.type === 'toast').length, 2);
    assert.strictEqual(serverA.chatRequests.length + serverB.chatRequests.length, 0);
  });
});
