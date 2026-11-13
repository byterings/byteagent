import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime';
import { createProvider } from '../../src/providers/factory';
import { ProjectStore } from '../../src/project/store';
import { nullLogger } from '../../src/shared/logger';
import { createToolRegistry } from '../../src/tools';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';
import { MockServer, type MockReply } from '../mock/mockServer';
import { acceptAll, FakeHost, RecordingEvents } from './helpers';

const wasmPath = join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const serverA = new MockServer();
const serverB = new MockServer();
let urlA = '';
let urlB = '';
let ws: TempWorkspace;
let storeDir: string;

beforeAll(async () => {
  urlA = await serverA.start();
  urlB = await serverB.start();
});
afterAll(async () => {
  await serverA.stop();
  await serverB.stop();
});
afterEach(() => {
  serverA.reset();
  serverB.reset();
  ws?.dispose();
  rmSync(storeDir, { recursive: true, force: true });
});

const PROMPT = 'Add token-based authentication across the API, with login, refresh and protected routes';
const tools = (...calls: Array<{ name: string; arguments: unknown }>): MockReply => ({ type: 'tools', calls });
const text = (t: string): MockReply => ({ type: 'text', text: t });
const plan = (statuses: string[]) => ({
  name: 'update_plan',
  arguments: {
    goal: 'Token authentication',
    criteria: ['Login returns tokens', 'Protected routes reject anonymous requests'],
    steps: ['Add token service', 'Add login endpoint', 'Protect order routes'].map((title, i) => ({ id: String(i + 1), title, status: statuses[i] })),
  },
});
const write = (path: string, content: string) => ({ name: 'propose_changes', arguments: { summary: `Add ${path}`, changes: [{ path, action: 'write', content }] } });

/** Everything a fresh editor session would have: a new store handle, host, events and runtime. */
async function session(baseUrl: string, providerId: string, model: string) {
  const store = await ProjectStore.open({ path: join(storeDir, 'agent.db'), wasmPath });
  const events = new RecordingEvents();
  const host = new FakeHost(ws.root);
  host.reviewer = acceptAll;
  const provider = createProvider({ id: providerId, baseUrl, model, timeoutSeconds: 5, toolCalling: 'native' }, { retryBaseDelayMs: 5 });
  const runtime = new AgentRuntime({
    provider,
    events,
    host,
    logger: nullLogger,
    workspace: { index: ws.index() },
    tools: createToolRegistry(),
    limits: { defaultContextWindow: 64000, confirmBeforeSend: false },
    tasks: store,
  });
  return { store, events, host, runtime, provider };
}

async function firstRun() {
  ws = tempWorkspace(sampleProject());
  storeDir = mkdtempSync(join(tmpdir(), 'byteagent-resume-'));
  serverA.enqueue(
    tools(plan(['in_progress', 'pending', 'pending'])),
    tools(write('src/auth/token.ts', 'export const sign = (id: string) => `token-${id}`;\n')),
    tools(plan(['done', 'in_progress', 'pending'])),
    text('The token service is done. The login endpoint is next.'),
  );
  const s = await session(urlA, 'provider-a', 'model-a');
  const result = await s.runtime.run({ prompt: PROMPT, attachments: [], mode: 'auto', history: [], sessionId: 'session-1' }, new AbortController().signal);
  s.store.recordRun({ sessionId: 'session-1', taskId: result.taskId, record: result.record, status: result.status, mode: result.mode, providerId: 'provider-a', model: 'model-a' });
  // The editor closes: everything in memory is gone.
  await s.store.dispose();
  return result;
}

const userMessage = (server: MockServer): string => server.chatRequests[0]!.body.messages.at(-1).content as string;

describe('Scenario D: a project task continues after a restart', () => {
  it('restores the task, its plan and its evidence from disk and continues', async () => {
    const first = await firstRun();
    expect(first.mode).toBe('project');
    const taskId = first.taskId!;

    const s = await session(urlA, 'provider-a', 'model-a');
    const saved = s.store.get(taskId)!;
    expect(saved).toMatchObject({ status: 'paused', goal: PROMPT, sessionId: 'session-1' });
    expect(saved.steps.map((st) => st.status)).toEqual(['done', 'in_progress', 'pending']);
    expect(Object.keys(saved.files)).toEqual(['src/auth/token.ts']);
    expect(s.store.events({ taskId }).map((e) => e.type)).toEqual(['run', 'changes_applied']);

    serverA.reset();
    serverA.enqueue(
      tools(write('src/routes/login.ts', 'export const login = () => "ok";\n')),
      tools(plan(['done', 'done', 'done'])),
      text('All steps are finished.'),
    );
    const result = await s.runtime.run({ prompt: 'Continue this task.', attachments: [], mode: 'project', history: [], sessionId: 'session-2', resumeTask: saved }, new AbortController().signal);

    expect(result.taskId).toBe(taskId);
    const brief = userMessage(serverA);
    expect(brief).toContain('You are continuing a saved task.');
    expect(brief).toContain(`Original request:\n${PROMPT}`);
    expect(brief).toContain('- [done] (1) Add token service');
    expect(brief).toContain('- [in_progress] (2) Add login endpoint');
    expect(brief).toContain('- Login returns tokens');
    expect(brief).toContain('Files changed (approved by the user): src/auth/token.ts');
    expect(brief).toContain('User request:\nContinue this task.');

    expect(s.events.of('classification')[0]).toMatchObject({ mode: 'project', reasons: ['Continuing a saved task'] });
    expect(s.events.of('plan')[0]?.steps.map((st) => st.status)).toEqual(['done', 'done', 'done']);
    expect(s.host.reviews).toHaveLength(1);

    const finished = s.store.get(taskId)!;
    expect(finished.status).toBe('done');
    expect(Object.keys(finished.files).sort()).toEqual(['src/auth/token.ts', 'src/routes/login.ts']);
    expect(finished.notes).toHaveLength(2);
    await s.store.dispose();
  });

  it('does not offer to resume a finished task as open work', async () => {
    const first = await firstRun();
    const s = await session(urlA, 'provider-a', 'model-a');
    serverA.reset();
    serverA.enqueue(tools(plan(['done', 'done', 'done'])), text('done'));
    await s.runtime.run({ prompt: 'Continue this task.', attachments: [], mode: 'project', history: [], resumeTask: s.store.get(first.taskId!) }, new AbortController().signal);
    expect(s.store.list().filter((t) => t.status !== 'done')).toEqual([]);
    await s.store.dispose();
  });
});

describe('Scenario E: switching provider in the middle of a task', () => {
  it('continues the same task on another provider from stored state only', async () => {
    const first = await firstRun();
    const taskId = first.taskId!;
    const requestsToA = serverA.chatRequests.length;

    // Someone edits a file the task created while the editor was closed.
    ws.write('src/auth/token.ts', 'export const sign = (id: string) => `v2-${id}`; // reviewed by a teammate\n');

    const s = await session(urlB, 'provider-b', 'model-b');
    serverB.enqueue(tools({ name: 'read_file', arguments: { path: 'src/auth/token.ts' } }), tools(plan(['done', 'done', 'in_progress'])), text('Continuing with provider B.'));
    const result = await s.runtime.run(
      { prompt: 'Continue this task.', attachments: [], mode: 'project', history: [{ user: 'unrelated earlier chat', assistant: 'unrelated earlier answer' }], sessionId: 'session-2', resumeTask: s.store.get(taskId) },
      new AbortController().signal,
    );
    s.store.recordRun({ sessionId: 'session-2', taskId: result.taskId, record: result.record, status: result.status, mode: result.mode, providerId: 'provider-b', model: 'model-b' });

    // Same task, same state.
    expect(result.taskId).toBe(taskId);
    expect(serverA.chatRequests).toHaveLength(requestsToA);
    expect(serverB.chatRequests[0]!.body.model).toBe('model-b');

    // The new provider gets a fresh package built from stored state, with no earlier conversation.
    const messages = serverB.chatRequests[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    const joined = JSON.stringify(messages);
    expect(joined).not.toContain('unrelated earlier chat');
    expect(joined).not.toContain('The token service is done. The login endpoint is next.');
    expect(messages[1]!.content).toContain('- [done] (1) Add token service');
    expect(messages[1]!.content).toContain('Project files selected for this request');

    // Files the task touched were re-checked against what was recorded.
    expect(messages[1]!.content).toContain('These files were modified or removed by someone else since then: src/auth/token.ts');
    expect(s.events.of('notice')[0]?.text).toMatch(/Changed since this task last touched it: src\/auth\/token\.ts/);
    // The refreshed context carries the current content, not the old one.
    expect(joined).toContain('reviewed by a teammate');
    expect(readFileSync(join(ws.root, 'src/auth/token.ts'), 'utf8')).toContain('v2-');

    const runs = s.store.events({ taskId }).filter((e) => e.type === 'run');
    expect(runs.map((e) => e.data.providerId)).toEqual(['provider-a', 'provider-b']);
    expect(s.store.get(taskId)?.steps.map((st) => st.status)).toEqual(['done', 'done', 'in_progress']);
    await s.store.dispose();
  });

  it('reports a file the task created that has since been deleted', async () => {
    const first = await firstRun();
    ws.remove('src/auth/token.ts');
    const s = await session(urlB, 'provider-b', 'model-b');
    serverB.enqueue(text('I see the token service is gone.'));
    await s.runtime.run({ prompt: 'Continue this task.', attachments: [], mode: 'project', history: [], resumeTask: s.store.get(first.taskId!) }, new AbortController().signal);
    expect(userMessage(serverB)).toContain('modified or removed by someone else since then: src/auth/token.ts');
    await s.store.dispose();
  });
});
