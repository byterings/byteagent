import { afterEach, describe, expect, it } from 'vitest';
import { parseTextToolCalls, toolInstructions, toTextProtocol } from '../../src/agent/textTools';
import { nullLogger } from '../../src/shared/logger';
import { createToolRegistry } from '../../src/tools';
import { ToolRegistry } from '../../src/tools/registry';
import { validateArguments, type SchemaNode } from '../../src/tools/schema';
import { newRunRecord, type PermissionClass, type ToolContext } from '../../src/tools/types';
import { FakeHost, RecordingEvents } from '../integration/helpers';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace | undefined;
afterEach(() => {
  ws?.dispose();
  ws = undefined;
});

function context(overrides: Partial<ToolContext> = {}, files: Record<string, string> = sampleProject()): ToolContext & { events: RecordingEvents } {
  ws = tempWorkspace(files);
  return {
    index: ws.index(),
    signal: new AbortController().signal,
    host: new FakeHost(ws.root),
    events: new RecordingEvents(),
    record: newRunRecord(),
    logger: nullLogger,
    redact: (t) => t,
    ...overrides,
  } as ToolContext & { events: RecordingEvents };
}

const READ: ReadonlySet<PermissionClass> = new Set(['read']);
const READ_PROPOSE: ReadonlySet<PermissionClass> = new Set(['read', 'propose']);
const call = (name: string, args: unknown) => ({ id: 'c1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });

describe('validateArguments', () => {
  const schema: SchemaNode = {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      flag: { type: 'boolean' },
      mode: { type: 'string', enum: ['a', 'b'] },
      items: { type: 'array', minItems: 1, items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    },
    required: ['path'],
  };

  it('accepts valid arguments and strips unknown properties', () => {
    const r = validateArguments(schema, { path: 'a', count: 3, extra: 'x', items: [{ name: 'n', junk: 1 }] });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ path: 'a', count: 3, items: [{ name: 'n' }] });
  });
  it('reports missing, mistyped and out-of-range values with their location', () => {
    const r = validateArguments(schema, { count: 99, flag: 'yes', mode: 'c', items: [{}] });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        'path is required.',
        'count must be at most 10.',
        'flag must be true or false, got string.',
        'mode must be one of: a, b.',
        'items[0].name is required.',
      ]),
    );
  });
  it('rejects non-objects, wrong container types, empty strings and fractions', () => {
    expect(validateArguments(schema, 'text').ok).toBe(false);
    expect(validateArguments(schema, null).ok).toBe(false);
    expect(validateArguments(schema, []).ok).toBe(false);
    expect(validateArguments(schema, { path: '' }).errors[0]).toMatch(/must not be empty/);
    expect(validateArguments(schema, { path: 'a', count: 1.5 }).errors[0]).toMatch(/whole number/);
    expect(validateArguments(schema, { path: 'a', items: 'x' }).errors[0]).toMatch(/must be a list/);
    expect(validateArguments(schema, { path: 'a', items: [] }).errors[0]).toMatch(/at least 1 item/);
    expect(validateArguments(schema, { path: 5 }).errors[0]).toMatch(/must be a string/);
  });
});

describe('ToolRegistry', () => {
  it('refuses unknown tools, bad JSON and invalid arguments before running anything', async () => {
    const registry = createToolRegistry();
    const ctx = context();
    expect((await registry.invoke(call('launch_missiles', {}), ctx, READ)).content).toMatch(/no tool named "launch_missiles"/);
    expect((await registry.invoke(call('read_file', '{not json'), ctx, READ)).content).toMatch(/not valid JSON/);
    expect((await registry.invoke(call('read_file', {}), ctx, READ)).content).toMatch(/path is required/);
    expect((await registry.invoke(call('read_file', { path: 7 }), ctx, READ)).content).toMatch(/must be a string/);
    expect(ctx.events.items).toEqual([]);
  });

  it('enforces permission classes in code', async () => {
    const registry = createToolRegistry();
    const ctx = context();
    const host = ctx.host as FakeHost;
    const result = await registry.invoke(call('propose_changes', { changes: [{ path: 'a.txt', action: 'write', content: 'x' }] }), ctx, READ);
    expect(result).toEqual({ ok: false, content: 'Error: the tool "propose_changes" is not permitted in this conversation.' });
    expect(host.reviews).toEqual([]);
    expect(registry.specs(READ).map((s) => s.name)).toEqual(['read_file', 'search_files', 'list_directory']);
    expect(registry.specs(READ_PROPOSE).map((s) => s.name)).toContain('propose_changes');
  });

  it('never runs a tool whose class is not allowed, even a custom one', async () => {
    let ran = false;
    const registry = new ToolRegistry().register({
      name: 'danger',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      permission: 'execute',
      showsRow: true,
      describe: () => ({ title: 'danger' }),
      execute: async () => {
        ran = true;
        return { ok: true, content: 'done' };
      },
    });
    const result = await registry.invoke(call('danger', {}), context(), READ_PROPOSE);
    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
    expect(() => registry.register(registry.get('danger') as NonNullable<ReturnType<typeof registry.get>>)).toThrow(/already registered/);
  });

  it('turns thrown errors into results, shows a row, and limits output size', async () => {
    const registry = new ToolRegistry()
      .register({
        name: 'boom',
        description: 'x',
        parameters: { type: 'object', properties: {} },
        permission: 'read',
        showsRow: true,
        describe: () => ({ title: 'boom' }),
        execute: async () => {
          throw new Error('internal detail that should not leak');
        },
      })
      .register({
        name: 'big',
        description: 'x',
        parameters: { type: 'object', properties: {} },
        permission: 'read',
        showsRow: true,
        describe: () => ({ title: 'big' }),
        execute: async () => ({ ok: true, content: 'word '.repeat(20000) }),
      });
    const ctx = context();
    const failed = await registry.invoke(call('boom', {}), ctx, READ);
    expect(failed).toEqual({ ok: false, content: 'Error: The tool failed unexpectedly.' });
    expect(ctx.events.of('tool')[0]).toMatchObject({ status: 'error' });
    const big = await registry.invoke(call('big', {}), ctx, READ);
    expect(big.content.length).toBeLessThan(30000);
    expect(big.content).toMatch(/Output shortened/);
  });

  it('redacts tool output', async () => {
    const registry = createToolRegistry();
    const ctx = context({ redact: (t) => t.split('TAX_RATE').join('[REDACTED]') });
    const result = await registry.invoke(call('read_file', { path: 'src/services/tax.ts' }), ctx, READ);
    expect(result.content).not.toContain('TAX_RATE');
  });

  it('stops immediately when the run was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createToolRegistry().invoke(call('read_file', { path: 'README.md' }), context({ signal: controller.signal }), READ)).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('read tools', () => {
  it('reads a file with a header and records it', async () => {
    const ctx = context();
    const result = await createToolRegistry().invoke(call('read_file', { path: 'src/services/tax.ts' }), ctx, READ);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('File: src/services/tax.ts (lines 1-1 of 1)\nexport const TAX_RATE = 0.2;');
    expect(ctx.record.filesRead.has('src/services/tax.ts')).toBe(true);
    expect(ctx.events.of('tool')[0]).toMatchObject({ title: 'Read src/services/tax.ts', status: 'done', detail: '1 line', path: 'src/services/tax.ts' });
  });

  it('reads a line range and pages through large files', async () => {
    const ctx = context({}, { 'big.txt': Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') });
    const registry = createToolRegistry();
    const range = await registry.invoke(call('read_file', { path: 'big.txt', start_line: 10, end_line: 12 }), ctx, READ);
    expect(range.content).toBe('File: big.txt (lines 10-12 of 1000)\nline 10\nline 11\nline 12\n[More lines follow. Call read_file with start_line=13 to continue.]');
    const first = await registry.invoke(call('read_file', { path: 'big.txt' }), ctx, READ);
    expect(first.content).toContain('(lines 1-400 of 1000)');
    expect(first.content).toContain('start_line=401');
    const swapped = await registry.invoke(call('read_file', { path: 'big.txt', start_line: 30, end_line: 20 }), ctx, READ);
    expect(swapped.content).toContain('(lines 20-30 of 1000)');
  });

  it('refuses blocked, outside and missing files without leaking content', async () => {
    const ctx = context();
    const registry = createToolRegistry();
    const env = await registry.invoke(call('read_file', { path: '.env' }), ctx, READ);
    expect(env.ok).toBe(false);
    expect(env.content).toMatch(/sensitive file/);
    expect(env.content).not.toContain('hunter2');
    expect((await registry.invoke(call('read_file', { path: '../../etc/passwd' }), ctx, READ)).content).toMatch(/outside the workspace/);
    expect((await registry.invoke(call('read_file', { path: 'node_modules/express/index.js' }), ctx, READ)).content).toMatch(/dependency or cache folder/);
    expect((await registry.invoke(call('read_file', { path: 'src/nope.ts' }), ctx, READ)).content).toMatch(/does not exist/);
    expect(ctx.events.of('tool').map((t) => t.detail)).toEqual(['blocked: sensitive file', 'blocked: outside workspace', 'blocked: excluded', 'not found']);
    expect(ctx.record.filesRead.size).toBe(0);
  });

  it('searches and lists without exposing blocked files', async () => {
    const ctx = context();
    const registry = createToolRegistry();
    const found = await registry.invoke(call('search_files', { query: 'orderTotal' }), ctx, READ);
    expect(found.content).toMatch(/^\d+ matches in 3 files:/);
    expect(found.content).toContain('src/services/pricing.ts:5: export function orderTotal');
    expect(found.content).not.toContain('node_modules');
    expect((await registry.invoke(call('search_files', { query: 'hunter2' }), ctx, READ)).content).toBe('No matches for "hunter2".');
    expect((await registry.invoke(call('search_files', { query: 'orderTotal', path: 'tests' }), ctx, READ)).content).toMatch(/in 1 file:/);
    expect((await registry.invoke(call('search_files', { query: 'x', path: 'node_modules' }), ctx, READ)).content).toMatch(/dependency or cache folder/);
    expect((await registry.invoke(call('search_files', { query: '(', regex: true }), ctx, READ)).content).toMatch(/Invalid regular expression/);

    const listed = await registry.invoke(call('list_directory', {}), ctx, READ);
    expect(listed.content).toContain('src/');
    expect(listed.content).toContain('package.json');
    expect(listed.content).not.toMatch(/^\.env$/m);
    expect(listed.content).not.toContain('node_modules');
    expect((await registry.invoke(call('list_directory', { path: 'src/services' }), ctx, READ)).content).toContain('pricing.ts');
  });
});

describe('text tool protocol', () => {
  const specs = createToolRegistry().specs(READ);

  it('describes the tools and the call format', () => {
    const text = toolInstructions(specs);
    expect(text).toContain('```tool_call');
    expect(text).toContain('### read_file');
    expect(text).toContain('### search_files');
  });

  it('parses fenced and tagged calls and removes them from the visible text', () => {
    const parsed = parseTextToolCalls(
      'Let me check.\n```tool_call\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n```\nand\n<tool_call>{"tool":"search_files","args":{"query":"x"}}</tool_call>\nDone.',
      'p',
    );
    expect(parsed.calls).toEqual([
      { id: 'p_0', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { id: 'p_1', name: 'search_files', arguments: '{"query":"x"}' },
    ]);
    expect(parsed.cleaned).toBe('Let me check.\n\nand\n\nDone.');
    expect(parsed.errors).toEqual([]);
  });

  it('reports malformed blocks instead of guessing', () => {
    const parsed = parseTextToolCalls('```tool_call\n{"name": read_file}\n```\n```tool_call\n{"arguments": {}}\n```', 'p');
    expect(parsed.calls).toEqual([]);
    expect(parsed.errors).toHaveLength(2);
  });

  it('leaves ordinary text and other code blocks alone', () => {
    const text = 'Use `tool_call` blocks.\n```ts\nconst x = 1;\n```';
    expect(parseTextToolCalls(text, 'p')).toEqual({ calls: [], cleaned: text, errors: [] });
  });

  it('rewrites a tool conversation into plain messages', () => {
    const out = toTextProtocol([
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'checking', toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"a"}' }, { id: '2', name: 'list_directory', arguments: '' }] },
      { role: 'tool', toolCallId: '1', name: 'read_file', content: 'file text' },
      { role: 'tool', toolCallId: '2', name: 'list_directory', content: 'src/' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
    expect(out[2]?.content).toContain('checking\n```tool_call\n{"name":"read_file","arguments":{"path":"a"}}\n```');
    expect(out[3]?.content).toBe('Tool results:\n\n[read_file]\nfile text\n\n[list_directory]\nsrc/\n\nContinue.');
    expect(out.every((m) => !('toolCalls' in m) || m.toolCalls === undefined)).toBe(true);
  });
});
