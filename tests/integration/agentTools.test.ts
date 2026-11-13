import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime, STEP_LIMITS } from '../../src/agent/runtime';
import { createProvider } from '../../src/providers/factory';
import { nullLogger } from '../../src/shared/logger';
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

interface SetupOptions {
  toolCalling?: 'auto' | 'native' | 'text';
  contextWindow?: number;
  files?: Record<string, string>;
}

function setup(options: SetupOptions = {}) {
  ws = tempWorkspace(options.files ?? sampleProject());
  const events = new RecordingEvents();
  const host = new FakeHost(ws.root);
  const provider = createProvider(
    { id: 'mock', baseUrl, model: 'mock-model', timeoutSeconds: 5, toolCalling: options.toolCalling ?? 'native', contextWindow: options.contextWindow },
    { retryBaseDelayMs: 5 },
  );
  const runtime = new AgentRuntime({
    provider,
    events,
    host,
    logger: nullLogger,
    workspace: { index: ws.index() },
    tools: createToolRegistry(),
    limits: { defaultContextWindow: 32000, confirmBeforeSend: false },
  });
  const run = (prompt: string, mode: 'auto' | 'quick' | 'standard' | 'project' = 'auto', signal = new AbortController().signal) =>
    runtime.run({ prompt, attachments: [], mode, history: [] }, signal);
  return { events, host, run };
}

const read = (rel: string): string => readFileSync(join(ws.root, rel), 'utf8');
const tools = (...calls: Array<{ name: string; arguments: unknown }>): MockReply => ({ type: 'tools', calls });
const text = (t: string): MockReply => ({ type: 'text', text: t });
/** Tool results the model received in request `n` (0-based). */
const toolResults = (n: number): string[] =>
  (server.chatRequests[n]!.body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => m.content);

const TAX_EDIT = { name: 'propose_changes', arguments: { summary: 'Raise the tax rate', changes: [{ path: 'src/services/tax.ts', action: 'edit', edits: [{ search: '0.2', replace: '0.25' }] }] } };

describe('tool loop: reading', () => {
  it('lets the model read a file and then answer from it', async () => {
    server.enqueue(tools({ name: 'read_file', arguments: { path: 'src/services/tax.ts' } }), text('The tax rate is 20%.'));
    const { events, run } = setup();
    const result = await run('How much tax do we charge?');

    expect(result.status).toBe('completed');
    expect(result.assistantText).toBe('The tax rate is 20%.');
    expect(server.chatRequests).toHaveLength(2);
    expect(server.chatRequests[0]!.body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['read_file', 'search_files', 'list_directory', 'propose_changes']);
    expect(toolResults(1)[0]).toContain('export const TAX_RATE = 0.2;');
    expect(events.of('tool')[0]).toMatchObject({ tool: 'read_file', status: 'done', path: 'src/services/tax.ts' });
    expect(events.of('changes')).toEqual([]);
    expect(result.record.filesRead.has('src/services/tax.ts')).toBe(true);
  });

  it('tells the model when a file is blocked, and sends none of its content', async () => {
    server.enqueue(tools({ name: 'read_file', arguments: { path: '.env' } }, { name: 'read_file', arguments: { path: '../../../etc/passwd' } }), text('I cannot read those.'));
    const { events, run } = setup();
    await run('print the env file');
    expect(toolResults(1)[0]).toMatch(/not available to ByteAgent \(sensitive file\)/);
    expect(toolResults(1)[1]).toMatch(/outside the workspace/);
    expect(JSON.stringify(server.chatRequests[1]!.body)).not.toContain('hunter2');
    expect(events.of('tool').map((t) => t.status)).toEqual(['error', 'error']);
  });

  it('returns errors for unknown tools and bad arguments so the model can correct itself', async () => {
    server.enqueue(
      tools({ name: 'run_shell', arguments: { cmd: 'ls' } }, { name: 'read_file', arguments: '{"path": ' }, { name: 'read_file', arguments: { file: 'x' } }),
      text('Sorry.'),
    );
    const { run } = setup();
    await run('do something');
    const results = toolResults(1);
    expect(results[0]).toMatch(/no tool named "run_shell"/);
    expect(results[1]).toMatch(/not valid JSON/);
    expect(results[2]).toMatch(/path is required/);
  });

  it('stops after the step limit instead of looping forever', async () => {
    server.respondWith(() => tools({ name: 'list_directory', arguments: {} }));
    const { events, run } = setup();
    const result = await run('loop');
    expect(result.status).toBe('completed');
    expect(server.chatRequests).toHaveLength(STEP_LIMITS.quick);
    expect(events.of('notice').at(-1)?.text).toMatch(/Stopped after 12 steps/);
  });

  it('drops old tool output to stay inside a small context window', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`data/part${i}.txt`] = `part ${i}\n${'lorem ipsum dolor sit amet\n'.repeat(120)}`;
    for (let i = 0; i < 6; i++) server.enqueue(tools({ name: 'read_file', arguments: { path: `data/part${i}.txt` } }));
    server.enqueue(text('done'));
    const { run } = setup({ files, contextWindow: 6000 });
    await run('read all parts');
    const last = toolResults(6);
    expect(last).toHaveLength(6);
    expect(last[0]).toMatch(/Earlier tool output removed/);
    expect(last[5]).toContain('part 5');
    expect(last[4]).toContain('part 4');
  });
});

describe('tool loop: proposing changes', () => {
  it('applies nothing until the user accepts, then applies exactly the proposal', async () => {
    server.enqueue(tools(TAX_EDIT), text('Done: the tax rate is now 25%.'));
    const { events, host, run } = setup();
    let onDiskDuringReview = '';
    host.reviewer = (set) => {
      onDiskDuringReview = read('src/services/tax.ts');
      return acceptAll(set);
    };
    const result = await run('raise tax to 25%');

    expect(onDiskDuringReview).toBe('export const TAX_RATE = 0.2;\n');
    expect(read('src/services/tax.ts')).toBe('export const TAX_RATE = 0.25;\n');
    expect(host.reviews).toHaveLength(1);
    expect(host.reviews[0]?.summary).toBe('Raise the tax rate');

    const card = events.of('changes')[0];
    expect(card).toMatchObject({ status: 'resolved' });
    expect(card?.files).toEqual([expect.objectContaining({ path: 'src/services/tax.ts', kind: 'modify', added: 1, removed: 1, status: 'applied' })]);
    expect(toolResults(1)[0]).toBe('Review result:\n- APPLIED: src/services/tax.ts');
    expect(result.record.applied).toEqual(['src/services/tax.ts']);
    expect(result.turn?.notes).toBe('Files changed (approved by the user): src/services/tax.ts');
  });

  it('leaves files untouched when the user rejects, and tells the model so (Scenario F)', async () => {
    server.enqueue(tools(TAX_EDIT), text('Understood, I have not changed anything.'));
    const { events, host, run } = setup();
    const result = await run('raise tax to 25%');

    expect(read('src/services/tax.ts')).toBe('export const TAX_RATE = 0.2;\n');
    expect(host.reviews).toHaveLength(1);
    expect(events.of('changes')[0]?.files[0]?.status).toBe('rejected');
    expect(toolResults(1)[0]).toContain('NOT applied, rejected by the user: src/services/tax.ts');
    expect(toolResults(1)[0]).toContain('Nothing was changed. Do not propose the same change again.');
    expect(result.record.applied).toEqual([]);
    expect(result.record.rejected).toEqual(['src/services/tax.ts']);
    expect(result.turn?.notes).toBe('Changes rejected by the user, not applied: src/services/tax.ts');
  });

  it('passes revision feedback to the model and reviews the new proposal', async () => {
    server.enqueue(
      tools(TAX_EDIT),
      tools({ name: 'propose_changes', arguments: { summary: 'Raise to 22%', changes: [{ path: 'src/services/tax.ts', action: 'edit', edits: [{ search: '0.2', replace: '0.22' }] }] } }),
      text('Set to 22% as requested.'),
    );
    const { events, host, run } = setup();
    host.reviewer = (set, count) => (count === 1 ? { decisions: {}, feedback: 'Use 22% instead' } : acceptAll(set));
    const result = await run('raise tax');

    expect(host.reviews).toHaveLength(2);
    expect(toolResults(1)[0]).toContain('The user asked for a revision: "Use 22% instead"');
    expect(read('src/services/tax.ts')).toBe('export const TAX_RATE = 0.22;\n');
    expect(events.of('changes').map((c) => c.files[0]?.status)).toEqual(['rejected', 'applied']);
    expect(events.of('changes')[0]?.feedback).toBe('Use 22% instead');
    expect(result.turn?.notes).toContain('User feedback on a proposal: Use 22% instead');
  });

  it('does not overwrite a file changed during review, and recovers with a fresh proposal (Scenario G)', async () => {
    server.enqueue(
      tools(TAX_EDIT),
      tools({ name: 'read_file', arguments: { path: 'src/services/tax.ts' } }),
      tools({ name: 'propose_changes', arguments: { changes: [{ path: 'src/services/tax.ts', action: 'edit', edits: [{ search: '0.19', replace: '0.25' }] }] } }),
      text('Updated on top of the newer file.'),
    );
    const { events, host, run } = setup();
    host.reviewer = (set, count) => {
      if (count === 1) ws.write('src/services/tax.ts', 'export const TAX_RATE = 0.19; // changed by a teammate\n');
      return acceptAll(set);
    };
    const result = await run('raise tax to 25%');

    expect(events.of('changes')[0]?.files[0]).toMatchObject({ status: 'stale' });
    expect(toolResults(1)[0]).toMatch(/NOT applied, The file changed after this preview was created/);
    expect(toolResults(1)[0]).toMatch(/Read src\/services\/tax.ts again/);
    // The teammate's edit survived and the second, fresh proposal was applied on top of it.
    expect(read('src/services/tax.ts')).toBe('export const TAX_RATE = 0.25; // changed by a teammate\n');
    expect(host.reviews).toHaveLength(2);
    expect(result.record.stale).toEqual(['src/services/tax.ts']);
    expect(result.record.applied).toEqual(['src/services/tax.ts']);
  });

  it('does not show an invalid proposal to the user', async () => {
    server.enqueue(
      tools({ name: 'propose_changes', arguments: { changes: [{ path: 'src/services/tax.ts', action: 'edit', edits: [{ search: 'TAX = 9', replace: 'x' }] }, { path: '.env', action: 'write', content: 'X=1' }] } }),
      text('I could not prepare that change.'),
    );
    const { events, host, run } = setup();
    await run('break things');
    expect(host.reviews).toEqual([]);
    expect(events.of('changes')).toEqual([]);
    expect(toolResults(1)[0]).toMatch(/not shown to the user because of problems/);
    expect(toolResults(1)[0]).toMatch(/was not found/);
    expect(toolResults(1)[0]).toMatch(/sensitive file/);
    expect(read('.env')).toContain('hunter2');
  });

  it('reviews several files and applies only the accepted ones', async () => {
    server.enqueue(
      tools({
        name: 'propose_changes',
        arguments: {
          summary: 'Three files',
          changes: [
            { path: 'src/services/tax.ts', action: 'edit', edits: [{ search: '0.2', replace: '0.3' }] },
            { path: 'src/services/vat.ts', action: 'write', content: 'export const VAT = 0.3;\n' },
            { path: 'src/services/email.ts', action: 'delete' },
          ],
        },
      }),
      text('Applied what you accepted.'),
    );
    const { events, host, run } = setup();
    host.reviewer = (set) => ({ decisions: { [set.changes[0]!.id]: 'accept', [set.changes[1]!.id]: 'accept', [set.changes[2]!.id]: 'reject' } });
    const result = await run('multi');
    expect(read('src/services/tax.ts')).toContain('0.3');
    expect(read('src/services/vat.ts')).toBe('export const VAT = 0.3;\n');
    expect(existsSync(join(ws.root, 'src/services/email.ts'))).toBe(true);
    expect(events.of('changes')[0]?.files.map((f) => [f.kind, f.status])).toEqual([['modify', 'applied'], ['create', 'applied'], ['delete', 'rejected']]);
    expect(toolResults(1)[0]).toContain('Only the files marked APPLIED were changed.');
    expect(result.record.applied).toHaveLength(2);
  });

  it('applies nothing when the run is stopped while a review is waiting', async () => {
    server.enqueue(tools(TAX_EDIT), text('never reached'));
    const { events, host, run } = setup();
    const controller = new AbortController();
    host.reviewer = () => {
      controller.abort();
      return { decisions: {} };
    };
    const result = await run('raise tax', 'auto', controller.signal);
    expect(result.status).toBe('cancelled');
    expect(read('src/services/tax.ts')).toBe('export const TAX_RATE = 0.2;\n');
    expect(events.of('changes')[0]?.files[0]?.status).toBe('rejected');
    expect(events.of('notice').at(-1)?.text).toBe('Stopped.');
    expect(server.chatRequests).toHaveLength(1);
  });

  it('does not offer retry after a failure that followed applied changes', async () => {
    server.enqueue(tools(TAX_EDIT), { type: 'error', status: 401, body: { error: { message: 'key revoked' } } });
    const { events, host, run } = setup();
    host.reviewer = acceptAll;
    const result = await run('raise tax');
    expect(result.status).toBe('failed');
    expect(events.of('error')[0]).toMatchObject({ code: 'auth', canRetry: false });
    // The applied change is still on record even though the run failed.
    expect(result.turn?.notes).toContain('Files changed (approved by the user): src/services/tax.ts');
  });
});

describe('tool loop: text fallback', () => {
  it('uses the text protocol when the profile asks for it', async () => {
    server.enqueue(
      text('I will check.\n```tool_call\n{"name": "read_file", "arguments": {"path": "src/services/tax.ts"}}\n```'),
      text('The tax rate is 20%.'),
    );
    const { events, run } = setup({ toolCalling: 'text' });
    const result = await run('How much tax?');

    const first = server.chatRequests[0]!.body;
    expect(first.tools).toBeUndefined();
    expect(first.messages[0].content).toContain('```tool_call');
    expect(first.messages[0].content).toContain('### read_file');

    const second = server.chatRequests[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(second.every((m) => m.role !== 'tool')).toBe(true);
    expect(second.at(-1)).toMatchObject({ role: 'user' });
    expect(second.at(-1)?.content).toContain('Tool results:');
    expect(second.at(-1)?.content).toContain('export const TAX_RATE = 0.2;');

    // The raw block is not left in the visible transcript.
    expect(events.of('assistant')[0]?.text).toBe('I will check.');
    expect(events.of('tool')[0]).toMatchObject({ tool: 'read_file', status: 'done' });
    expect(result.assistantText).toContain('The tax rate is 20%.');
  });

  it('switches to the text protocol when the endpoint rejects native tools', async () => {
    server.enqueue(
      { type: 'error', status: 400, body: { error: { message: 'This model does not support tools.' } } },
      text('```tool_call\n{"name": "list_directory", "arguments": {}}\n```'),
      text('Listed.'),
    );
    const { events, run } = setup({ toolCalling: 'auto' });
    const result = await run('what is here?');
    expect(result.status).toBe('completed');
    expect(server.chatRequests[0]!.body.tools).toBeDefined();
    expect(server.chatRequests[1]!.body.tools).toBeUndefined();
    expect(events.of('notice')[0]?.text).toMatch(/text-based fallback/);
    expect(events.of('tool')[0]).toMatchObject({ tool: 'list_directory', status: 'done' });
  });

  it('reviews changes proposed through the text protocol exactly like native ones', async () => {
    server.enqueue(text(`\`\`\`tool_call\n${JSON.stringify(TAX_EDIT)}\n\`\`\``), text('Not changed.'));
    const { host, run } = setup({ toolCalling: 'text' });
    await run('raise tax');
    expect(host.reviews).toHaveLength(1);
    expect(read('src/services/tax.ts')).toBe('export const TAX_RATE = 0.2;\n');
  });

  it('reports a malformed text tool call back to the model', async () => {
    server.enqueue(text('```tool_call\n{"name": read_file}\n```'), text('Sorry, answering directly.'));
    const { run } = setup({ toolCalling: 'text' });
    await run('q');
    const messages = server.chatRequests[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-1)?.content).toMatch(/Problem with your tool call/);
  });
});
