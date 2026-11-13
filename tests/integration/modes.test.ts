import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/agent/runtime';
import { MemoryTaskTracker } from '../../src/agent/taskState';
import { createProvider } from '../../src/providers/factory';
import { nullLogger } from '../../src/shared/logger';
import type { ModeSetting } from '../../src/shared/protocol';
import { createToolRegistry } from '../../src/tools';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';
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

function setup() {
  ws = tempWorkspace(sampleProject());
  const events = new RecordingEvents();
  const host = new FakeHost(ws.root);
  const tasks = new MemoryTaskTracker();
  const runtime = () =>
    new AgentRuntime({
      provider: createProvider({ id: 'mock', baseUrl, model: 'mock-model', timeoutSeconds: 5, toolCalling: 'native' }, { retryBaseDelayMs: 5 }),
      events,
      host,
      logger: nullLogger,
      workspace: { index: ws.index() },
      tools: createToolRegistry(),
      limits: { defaultContextWindow: 64000, confirmBeforeSend: false },
      tasks,
    });
  const run = (prompt: string, mode: ModeSetting = 'auto') => runtime().run({ prompt, attachments: [], mode, history: [], sessionId: 's1' }, new AbortController().signal);
  return { events, host, tasks, run };
}

const tools = (...calls: Array<{ name: string; arguments: unknown }>): MockReply => ({ type: 'tools', calls });
const text = (t: string): MockReply => ({ type: 'text', text: t });
const toolNames = (n: number): string[] => (server.chatRequests[n]!.body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
const systemPrompt = (n: number): string => server.chatRequests[n]!.body.messages[0].content;
const messagesOf = (n: number): Array<{ role: string; content: string }> => server.chatRequests[n]!.body.messages;
const toolResults = (n: number): string[] => messagesOf(n).filter((m) => m.role === 'tool').map((m) => m.content);
const edit = (path: string, search: string, replace: string) => ({ path, action: 'edit', edits: [{ search, replace }] });
const write = (path: string, content = 'export {};\n') => ({ path, action: 'write', content });
const PLAN = {
  name: 'update_plan',
  arguments: {
    goal: 'Token authentication',
    criteria: ['Login returns tokens', 'Protected routes reject anonymous requests'],
    steps: [{ id: '1', title: 'Inspect routes', status: 'done' }, { id: '2', title: 'Add token service', status: 'in_progress' }, { id: '3', title: 'Protect order routes' }],
  },
};

describe('Scenario A: read-only question', () => {
  it('runs in Quick mode with no plan tool, no diff and no task', async () => {
    server.enqueue(text('It totals the order lines, adds tax and applies the coupon.'));
    const { events, tasks, run } = setup();
    const result = await run('What does the orderTotal function do?');
    expect(result.mode).toBe('quick');
    expect(events.of('classification')[0]).toMatchObject({ mode: 'quick', auto: true });
    expect(toolNames(0)).not.toContain('update_plan');
    expect(systemPrompt(0)).toContain('This is a Quick task');
    expect(events.of('changes')).toEqual([]);
    expect(events.of('plan')).toEqual([]);
    expect(events.of('outcome')).toEqual([]);
    expect(tasks.list()).toEqual([]);
    expect(result.taskId).toBeUndefined();
    // Minimal retrieval: a handful of files at most.
    expect(events.of('context')[0]?.files.length).toBeLessThanOrEqual(4);
  });
});

describe('Scenario B: small edit', () => {
  it('classifies as Quick, retrieves little, and still requires review before writing', async () => {
    server.enqueue(tools({ name: 'propose_changes', arguments: { summary: 'Raise the rate', changes: [edit('src/services/tax.ts', '0.2', '0.25')] } }), text('Updated.'));
    const { events, host, run } = setup();
    let diskDuringReview = '';
    host.reviewer = (set) => {
      diskDuringReview = readFileSync(join(ws.root, 'src/services/tax.ts'), 'utf8');
      return acceptAll(set);
    };
    const result = await run('Change the default tax rate constant in tax.ts to 0.25');
    expect(result.mode).toBe('quick');
    expect(events.of('context')[0]?.files.map((f) => f.path)).toContain('src/services/tax.ts');
    expect(host.reviews).toHaveLength(1);
    expect(diskDuringReview).toContain('0.2;');
    expect(readFileSync(join(ws.root, 'src/services/tax.ts'), 'utf8')).toContain('0.25');
    expect(events.of('classification')).toHaveLength(1);
  });
});

describe('Scenario C: multi-file feature', () => {
  it('classifies as Standard, offers the plan tool, and records test results', async () => {
    server.enqueue(
      tools({ name: 'read_file', arguments: { path: 'src/routes/orders.ts' } }),
      tools({ name: 'propose_changes', arguments: { summary: 'List endpoint and test', changes: [edit('src/routes/orders.ts', "ordersRouter.post('/'", "ordersRouter.get('/', (_req, res) => res.json([]));\nordersRouter.post('/'"), write('tests/routes/orders.test.ts', "// test\n")] } }),
      tools({ name: 'run_command', arguments: { command: 'node -e "process.exit(0)"', purpose: 'placeholder check' } }),
      text('Added the endpoint and a test.'),
    );
    const { events, host, run } = setup();
    host.reviewer = acceptAll;
    host.approver = () => 'once';
    const result = await run('Add an API endpoint for listing orders and tests for it');

    expect(result.mode).toBe('standard');
    expect(events.of('classification')[0]?.reasons.join(' ')).toMatch(/tests|related files/i);
    expect(toolNames(0)).toContain('update_plan');
    expect(systemPrompt(0)).toContain('This is a Standard task');
    expect(events.of('context')[0]?.files.map((f) => f.path)).toContain('src/routes/orders.ts');
    expect(host.reviews[0]?.changes.map((c) => c.path).sort()).toEqual(['src/routes/orders.ts', 'tests/routes/orders.test.ts']);
    const outcome = events.of('outcome')[0]?.outcome;
    expect(outcome?.applied.sort()).toEqual(['src/routes/orders.ts', 'tests/routes/orders.test.ts']);
    expect(outcome?.commands).toHaveLength(1);
    // The command was not a recognised check, so the result is honestly "not verified".
    expect(outcome?.verification).toBe('not_run');
  });
});

describe('Scenario D: large architectural task', () => {
  const PROMPT = 'Add token-based authentication across the API, with login, refresh and protected routes';

  it('uses Project mode, persists criteria and steps, and reviews changes', async () => {
    server.enqueue(
      tools({ name: 'list_directory', arguments: { path: 'src' } }),
      tools(PLAN),
      tools({ name: 'propose_changes', arguments: { summary: 'Token service', changes: [write('src/auth/token.ts', 'export const sign = () => "t";\n')] } }),
      tools({ name: 'update_plan', arguments: { steps: [{ id: '1', title: 'Inspect routes', status: 'done' }, { id: '2', title: 'Add token service', status: 'done' }, { id: '3', title: 'Protect order routes', status: 'in_progress' }] } }),
      text('The token service is in place. Next I will protect the order routes.'),
    );
    const { events, host, tasks, run } = setup();
    host.reviewer = acceptAll;
    const result = await run(PROMPT);

    expect(result.mode).toBe('project');
    expect(systemPrompt(0)).toContain('This is a Project task');
    expect(toolNames(0)).toContain('update_plan');
    expect(host.reviews).toHaveLength(1);

    const planItems = events.of('plan');
    expect(planItems).toHaveLength(1);
    expect(planItems[0]).toMatchObject({ goal: 'Token authentication', criteria: PLAN.arguments.criteria });
    expect(planItems[0]?.steps.map((s) => s.status)).toEqual(['done', 'done', 'in_progress']);
    expect(toolResults(2).at(-1)).toBe('Plan saved: 1 of 3 steps done.');

    expect(result.taskId).toBeDefined();
    const saved = tasks.get(result.taskId!)!;
    expect(saved).toMatchObject({ mode: 'project', status: 'paused', goal: PROMPT, sessionId: 's1', criteria: PLAN.arguments.criteria });
    expect(saved.steps.map((s) => [s.id, s.status])).toEqual([['1', 'done'], ['2', 'done'], ['3', 'in_progress']]);
    expect(Object.keys(saved.files)).toEqual(['src/auth/token.ts']);
    expect(saved.notes[0]).toContain('Files changed (approved by the user): src/auth/token.ts');
    expect(events.of('notice').at(-1)?.text).toBe('Task saved with 2 of 3 steps done. You can resume it from History.');
    expect(existsSync(join(ws.root, 'src/auth/token.ts'))).toBe(true);
  });

  it('marks the task done when every step is done', async () => {
    server.enqueue(tools({ name: 'update_plan', arguments: { goal: 'Auth', steps: [{ title: 'Only step', status: 'done' }] } }), text('Finished.'));
    const { tasks, run } = setup();
    const result = await run(PROMPT);
    expect(tasks.get(result.taskId!)?.status).toBe('done');
  });

  it('reminds the model to record a plan when it has not after three steps', async () => {
    for (let i = 0; i < 3; i++) server.enqueue(tools({ name: 'list_directory', arguments: {} }));
    server.enqueue(text('ok'));
    const { run } = setup();
    await run(PROMPT);
    const reminders = messagesOf(3).filter((m) => m.role === 'user' && m.content.includes('no plan has been recorded yet'));
    expect(reminders).toHaveLength(1);
  });

  it('rejects a malformed plan and tells the model why', async () => {
    server.enqueue(tools({ name: 'update_plan', arguments: { steps: [{ title: '   ' }] } }), text('ok'));
    const { events, run } = setup();
    await run(PROMPT);
    expect(toolResults(1)[0]).toMatch(/the plan was not saved/);
    expect(events.of('plan')).toEqual([]);
  });
});

describe('escalation', () => {
  it('moves a Quick task to Standard when the proposal touches more files than expected', async () => {
    server.enqueue(
      tools({ name: 'propose_changes', arguments: { summary: 'Rename', changes: [edit('src/services/tax.ts', 'TAX_RATE', 'VAT_RATE'), edit('src/services/pricing.ts', "import { TAX_RATE } from './tax';", "import { VAT_RATE as TAX_RATE } from './tax';"), write('src/services/vat.md', 'note\n')] } }),
      text('Renamed.'),
    );
    const { events, host, run } = setup();
    host.reviewer = acceptAll;
    const result = await run('Rename the constant in this file');

    expect(events.of('classification').map((c) => [c.mode, c.escalatedFrom])).toEqual([['quick', undefined], ['standard', 'quick']]);
    expect(events.of('classification')[1]?.reasons).toEqual(['The change touches 3 files']);
    expect(result.mode).toBe('standard');
    // The next request carries the new mode's instructions and tools.
    expect(systemPrompt(0)).toContain('This is a Quick task');
    expect(systemPrompt(1)).toContain('This is a Standard task');
    expect(toolNames(0)).not.toContain('update_plan');
    expect(toolNames(1)).toContain('update_plan');
    expect(messagesOf(1).at(-1)?.content).toMatch(/larger than it first looked.*Standard task/);
    // Escalation never skipped the review.
    expect(host.reviews).toHaveLength(1);
  });

  it('moves straight to Project for a wide change and starts tracking a task', async () => {
    const changes = ['src/a/one.ts', 'src/b/two.ts', 'tests/three.ts', 'docs/four.md', 'scripts/five.ts', 'config/six.ts'].map((p) => write(p));
    server.enqueue(tools({ name: 'propose_changes', arguments: { summary: 'Wide', changes } }), tools(PLAN), text('Planned.'));
    const { events, host, tasks, run } = setup();
    host.reviewer = acceptAll;
    const result = await run('Tidy this up');
    expect(result.mode).toBe('project');
    expect(events.of('classification').at(-1)).toMatchObject({ mode: 'project', escalatedFrom: 'quick' });
    expect(tasks.get(result.taskId!)?.steps).toHaveLength(3);
    expect(messagesOf(1).at(-1)?.content).toMatch(/Call update_plan/);
  });

  it('does not escalate when the user pinned the mode, and does not offer the plan tool in Quick', async () => {
    server.enqueue(
      tools({ name: 'propose_changes', arguments: { summary: 'Three', changes: [write('a1.ts'), write('a2.ts'), write('a3.ts')] } }),
      tools(PLAN),
      text('done'),
    );
    const { events, host, tasks, run } = setup();
    host.reviewer = acceptAll;
    const result = await run('Add token-based authentication across the API, with login, refresh and protected routes', 'quick');
    expect(result.mode).toBe('quick');
    expect(events.of('classification')).toHaveLength(1);
    expect(events.of('classification')[0]).toMatchObject({ mode: 'quick', auto: false });
    expect(events.of('classification')[0]?.reasons).toEqual(['You chose Quick mode', 'ByteAgent would have picked Project']);
    expect(toolNames(0)).not.toContain('update_plan');
    expect(toolResults(2).at(-1)).toMatch(/"update_plan" is not permitted/);
    expect(tasks.list()).toEqual([]);
    expect(host.reviews).toHaveLength(1);
  });
});

describe('safety is identical in every mode', () => {
  const modes: ModeSetting[] = ['quick', 'standard', 'project'];

  it.each(modes)('in %s mode nothing is written without review', async (mode) => {
    server.enqueue(tools({ name: 'propose_changes', arguments: { changes: [edit('src/services/tax.ts', '0.2', '0.9')] } }), text('ok'));
    const { host, run } = setup();
    await run('change the tax rate', mode); // default reviewer rejects
    expect(host.reviews).toHaveLength(1);
    expect(readFileSync(join(ws.root, 'src/services/tax.ts'), 'utf8')).toContain('0.2;');
  });

  it.each(modes)('in %s mode no command runs without approval', async (mode) => {
    server.enqueue(tools({ name: 'run_command', arguments: { command: `node -e "require('fs').writeFileSync('ran.txt','x')"` } }), text('ok'));
    const { host, run } = setup();
    await run('run it', mode); // default approver denies
    expect(host.commandRequests).toHaveLength(1);
    expect(existsSync(join(ws.root, 'ran.txt'))).toBe(false);
  });

  it.each(modes)('in %s mode blocked files stay blocked', async (mode) => {
    server.enqueue(tools({ name: 'read_file', arguments: { path: '.env' } }, { name: 'propose_changes', arguments: { changes: [write('.env', 'X=1\n')] } }), text('ok'));
    const { host, run } = setup();
    await run('touch env', mode);
    expect(toolResults(1)[0]).toMatch(/sensitive file/);
    expect(toolResults(1)[1]).toMatch(/sensitive file/);
    expect(host.reviews).toEqual([]);
    expect(JSON.stringify(server.chatRequests[1]!.body)).not.toContain('hunter2');
  });
});
