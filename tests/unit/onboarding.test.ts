import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, newTask } from '../../src/agent/taskState';
import { renderTaskSection, syncStatusDocument, TASKS_END, TASKS_START } from '../../src/project/docsSync';
import { describeBaseline, inspectProject, planOnboarding, renderStatus, requirementItems } from '../../src/project/onboarding';
import type { StoredVerification } from '../../src/project/store';
import { sampleProject, tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace | undefined;
afterEach(() => {
  ws?.dispose();
  ws = undefined;
});

const DATE = '2026-11-13';
const content = (plan: Awaited<ReturnType<typeof planOnboarding>>, path: string): string => {
  const op = plan.operations.find((o) => o.path === path);
  if (!op || op.type !== 'write') throw new Error(`no write for ${path}`);
  return op.content;
};

describe('inspectProject', () => {
  it('reports what the files show for an existing project', async () => {
    ws = tempWorkspace({ ...sampleProject(), 'AGENTS.md': '# rules\n', 'docs/guide.md': 'x\n' });
    mkdirSync(join(ws.root, '.git'));
    ws.write('.git/HEAD', 'ref: refs/heads/develop\n');
    const baseline = await inspectProject(ws.index(), 'shop-api');
    expect(baseline.kind).toBe('existing');
    expect(baseline.git).toEqual({ repository: true, branch: 'develop' });
    expect(baseline.facts.testCommands).toEqual(['npm test']);
    expect(baseline.existingDocs.map((d) => [d.path, d.kind])).toEqual([
      ['AGENTS.md', 'agent instructions'],
      ['docs/', 'documentation folder'],
      ['README.md', 'readme'],
    ]);
    expect(baseline.likelyEntryPoints).toEqual(expect.arrayContaining(['src/index.ts', 'src/app.ts']));
    expect(baseline.testLocations).toEqual(['tests/']);
    expect(baseline.readmeExcerpt).toBe('Handles orders, pricing and coupons.');
    expect(baseline.existingKnowledge).toEqual([]);
  });

  it('recognises a workspace without source files as a new project', async () => {
    ws = tempWorkspace({ 'README.md': '# Idea\n' });
    const baseline = await inspectProject(ws.index(), 'idea');
    expect(baseline.kind).toBe('new');
    expect(baseline.git.repository).toBe(false);
    expect(baseline.sourceFileCount).toBe(0);
  });

  it('distinguishes declared entry points from guessed ones', async () => {
    ws = tempWorkspace({ 'package.json': '{"main":"./lib/start.js","bin":{"tool":"bin/tool.js"}}', 'lib/start.js': '', 'src/index.js': '' });
    const baseline = await inspectProject(ws.index(), 'x');
    expect(baseline.declaredEntryPoints).toEqual([
      { path: 'lib/start.js', source: 'package.json "main"' },
      { path: 'bin/tool.js', source: 'package.json "bin"' },
    ]);
    expect(baseline.likelyEntryPoints).toEqual(['src/index.js']);
  });
});

describe('planOnboarding for an existing project', () => {
  it('proposes only missing knowledge files and touches no existing document', async () => {
    ws = tempWorkspace({ ...sampleProject(), 'AGENTS.md': '# my rules\n' });
    const plan = await planOnboarding(ws.index(), { name: 'shop-api', date: DATE, includeAgentsFile: true });
    expect(plan.operations.map((o) => o.path)).toEqual(['.byteagent/context.md', '.byteagent/project_status.md', '.byteagent/roadmap.md', '.byteagent/decisions.md', '.byteagent/.gitignore']);
    expect(plan.operations.every((o) => o.type === 'write')).toBe(true);
    expect(plan.kept).toEqual(['AGENTS.md']);
  });

  it('keeps facts, inferences and unknowns apart, each fact with its source', async () => {
    ws = tempWorkspace(sampleProject());
    const context = content(await planOnboarding(ws.index(), { name: 'shop-api', date: DATE }), '.byteagent/context.md');
    const facts = context.slice(context.indexOf('## Discovered facts'), context.indexOf('## Inferences'));
    const inferences = context.slice(context.indexOf('## Inferences'), context.indexOf('## Unknown'));
    const unknown = context.slice(context.indexOf('## Unknown'), context.indexOf('## Notes for agents'));

    expect(facts).toContain('Languages: TypeScript');
    expect(facts).toContain('Test command: `npm test`. Source: project manifest.');
    expect(facts).toContain('Frameworks and tools: Express');
    expect(facts).toContain('Git repository: no `.git` folder was found.');
    expect(facts).not.toContain('probably');

    expect(inferences).toContain('`src/index.ts` is probably an entry point (conventional file name).');
    expect(inferences).toContain('Purpose, as described by the README (not checked against the code): "Handles orders, pricing and coupons."');

    expect(unknown).toContain('Whether the tests currently pass: they have not been run by ByteAgent.');
    expect(unknown).toContain('How the project is deployed');
    expect(context).toContain(`Created by ByteAgent on ${DATE}`);
  });

  it('never claims that anything works or is complete', async () => {
    ws = tempWorkspace(sampleProject());
    const plan = await planOnboarding(ws.index(), { name: 'shop-api', date: DATE });
    const status = content(plan, '.byteagent/project_status.md');
    expect(status).toContain('Nothing yet. ByteAgent has not run any test, build or check in this project.');
    expect(status).toContain('Features described in the README or other documents have not been checked against the code.');
    expect(status).toContain(TASKS_START);
    expect(status).toContain(TASKS_END);
    const all = plan.operations.map((o) => (o.type === 'write' ? o.content : '')).join('\n');
    expect(all).not.toMatch(/\b(tests pass|all tests passing|fully implemented|is complete|works correctly)\b/i);
    expect(all).not.toMatch(/Status: done/);
  });

  it('proposes a roadmap without inventing items', async () => {
    ws = tempWorkspace(sampleProject());
    const roadmap = content(await planOnboarding(ws.index(), { name: 'shop-api', date: DATE }), '.byteagent/roadmap.md');
    expect(roadmap).toContain('No roadmap was found in this project, and ByteAgent has not invented one.');
    expect(roadmap).toContain('An item here is not proof that anything is implemented.');
    expect(roadmap.slice(0, roadmap.indexOf('## Format'))).not.toMatch(/### R-\d+/);
  });

  it('leaves existing knowledge files alone on a second run', async () => {
    ws = tempWorkspace({ ...sampleProject(), '.byteagent/context.md': '# mine\n', '.byteagent/roadmap.md': '# my roadmap\n' });
    const plan = await planOnboarding(ws.index(), { name: 'shop-api', date: DATE });
    expect(plan.kept).toEqual(['.byteagent/context.md', '.byteagent/roadmap.md']);
    expect(plan.operations.map((o) => o.path)).toEqual(['.byteagent/project_status.md', '.byteagent/decisions.md', '.byteagent/.gitignore']);
    expect(plan.baseline.existingKnowledge).toEqual(['.byteagent/context.md', '.byteagent/roadmap.md']);
  });

  it('creates AGENTS.md only on request and only when absent', async () => {
    ws = tempWorkspace(sampleProject());
    const without = await planOnboarding(ws.index(), { name: 'x', date: DATE });
    expect(without.operations.map((o) => o.path)).not.toContain('AGENTS.md');
    const withFile = await planOnboarding(ws.index(), { name: 'x', date: DATE, includeAgentsFile: true });
    expect(content(withFile, 'AGENTS.md')).toContain('- Tests: `npm test`');
  });

  it('keeps the local database out of version control', async () => {
    ws = tempWorkspace(sampleProject());
    expect(content(await planOnboarding(ws.index(), { name: 'x', date: DATE }), '.byteagent/.gitignore')).toContain('agent.db');
  });

  it('describes the result honestly', async () => {
    ws = tempWorkspace(sampleProject());
    const text = describeBaseline(await planOnboarding(ws.index(), { name: 'shop-api', date: DATE }));
    expect(text).toContain('I scanned **shop-api**');
    expect(text).toContain('Test command found: `npm test`. I have not run it.');
    expect(text).toContain('`README.md`) are left untouched');
    expect(text).toContain('The roadmap contains no invented items.');
  });
});

describe('planOnboarding for a new project', () => {
  it('uses the stated requirements, as proposals', async () => {
    ws = tempWorkspace({});
    const plan = await planOnboarding(ws.index(), { name: 'todo', date: DATE, requirements: '- A REST API for todo items\n- Store items in SQLite\n- Tests for every endpoint' });
    expect(plan.baseline.kind).toBe('new');
    const context = content(plan, '.byteagent/context.md');
    expect(context).toContain('## Stated requirements');
    expect(context).toContain('- Store items in SQLite');
    const roadmap = content(plan, '.byteagent/roadmap.md');
    expect(roadmap).toContain('### R-001\n- Title: A REST API for todo items\n- Status: proposed');
    expect(roadmap).toContain('### R-003\n- Title: Tests for every endpoint\n- Status: proposed');
    expect(roadmap).toContain('They are proposals until you confirm them.');
    expect(content(plan, '.byteagent/project_status.md')).toContain('The project has no source files yet');
    expect(describeBaseline(plan)).toContain('has no source files yet');
  });

  it('splits prose requirements into sentences and handles none', async () => {
    expect(requirementItems('Build a CLI. It should read CSV files! Output JSON.')).toEqual(['Build a CLI.', 'It should read CSV files!', 'Output JSON.']);
    expect(requirementItems('1. First\n2) Second\n* Third')).toEqual(['First', 'Second', 'Third']);
    ws = tempWorkspace({});
    const roadmap = content(await planOnboarding(ws.index(), { name: 'x', date: DATE }), '.byteagent/roadmap.md');
    expect(roadmap).toContain('No requirements were given.');
  });
});

describe('status document sync', () => {
  const task = () => {
    const t = applyPlanUpdate(newTask({ goal: 'Add authentication', mode: 'project' }, Date.UTC(2026, 10, 13)), {
      steps: [{ title: 'Inspect', status: 'done' }, { title: 'Build', status: 'in_progress' }, { title: 'Docs', status: 'skipped' }],
    }, Date.UTC(2026, 10, 13)).task;
    return { ...t, files: { 'src/b.ts': 'h', 'src/a.ts': 'h' } };
  };
  const check = (over: Partial<StoredVerification>): StoredVerification => ({ id: 1, command: 'npm test', status: 'done', exitCode: 0, durationMs: 5, isCheck: true, outputSummary: '', createdAt: Date.UTC(2026, 10, 13), ...over });

  it('renders tasks from stored state with recorded checks only', () => {
    const t = task();
    const section = renderTaskSection([t], [check({ taskId: t.id, exitCode: 1 }), check({ taskId: t.id, id: 2, exitCode: 0 }), check({ taskId: 'other', command: 'npm run lint' }), check({ taskId: t.id, command: 'git status', isCheck: false })]);
    expect(section).toBe(
      [
        '### Add authentication',
        '- Status: in progress (1 of 2 steps done)',
        '- Last updated: 2026-11-13',
        '- Steps:',
        '  - [x] Inspect',
        '  - [~] Build',
        '  - [-] Docs',
        '- Files changed: `src/a.ts`, `src/b.ts`',
        '- Checks run:',
        '  - `npm test`: exit code 0 on 2026-11-13',
      ].join('\n'),
    );
    expect(renderTaskSection([t], [])).toContain('- Checks run: none recorded');
    expect(renderTaskSection([], [])).toBe('No tracked tasks yet.');
  });

  it('replaces only the marked section and leaves the rest of the document alone', () => {
    const document = renderStatus({ kind: 'existing' } as never, DATE).replace('## Not verified', 'My own notes stay here.\n\n## Not verified');
    const updated = syncStatusDocument(document, '### Task A\n- Status: done');
    expect(updated).toContain(`${TASKS_START}\n### Task A\n- Status: done\n${TASKS_END}`);
    expect(updated).toContain('My own notes stay here.');
    expect(updated).toContain('## Verified by ByteAgent');
    expect(updated).not.toContain('No tracked tasks yet.');
    // Applying the same section again changes nothing.
    expect(syncStatusDocument(updated!, '### Task A\n- Status: done')).toBeUndefined();
  });

  it('leaves a document without markers completely alone', () => {
    expect(syncStatusDocument('# My status\n\nHand written.\n', 'x')).toBeUndefined();
    expect(syncStatusDocument(`${TASKS_END}\n${TASKS_START}`, 'x')).toBeUndefined();
  });
});
