import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ChangeOperation } from '../changes/types';
import { detectProject, type ProjectFacts } from '../context/techDetect';
import type { WorkspaceIndex } from '../context/workspaceIndex';
import { TASKS_END, TASKS_START } from './docsSync';

export const KNOWLEDGE_DIR = '.byteagent';
export const CONTEXT_FILE = `${KNOWLEDGE_DIR}/context.md`;
export const STATUS_FILE = `${KNOWLEDGE_DIR}/project_status.md`;
export const ROADMAP_FILE = `${KNOWLEDGE_DIR}/roadmap.md`;
export const DECISIONS_FILE = `${KNOWLEDGE_DIR}/decisions.md`;
export const IGNORE_FILE = `${KNOWLEDGE_DIR}/.gitignore`;

export interface ExistingDoc {
  path: string;
  kind: 'agent instructions' | 'readme' | 'contributing guide' | 'documentation folder' | 'changelog' | 'license' | 'roadmap or status';
}

/** What ByteAgent could establish about a project, with the certainty of each part kept apart. */
export interface ProjectBaseline {
  name: string;
  kind: 'existing' | 'new';
  facts: ProjectFacts;
  fileCount: number;
  sourceFileCount: number;
  scanTruncated: boolean;
  git: { repository: boolean; branch?: string };
  existingDocs: ExistingDoc[];
  /** Knowledge files that are already present and will be left alone. */
  existingKnowledge: string[];
  /** Entry points stated in a manifest. */
  declaredEntryPoints: Array<{ path: string; source: string }>;
  /** Entry points guessed from conventional names. */
  likelyEntryPoints: string[];
  testLocations: string[];
  readmeExcerpt?: string;
}

const SOURCE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'cs', 'rb', 'php', 'swift', 'c', 'cpp', 'cc', 'h', 'hpp', 'dart', 'scala', 'vue', 'svelte']);

const DOC_FILES: Array<[RegExp, ExistingDoc['kind']]> = [
  [/^(AGENTS\.md|\.cursorrules|\.github\/copilot-instructions\.md|\.windsurfrules|\.byteagent\/rules\.md)$/i, 'agent instructions'],
  [/^README(\.[a-z]+)?$/i, 'readme'],
  [/^CONTRIBUTING(\.[a-z]+)?$/i, 'contributing guide'],
  [/^CHANGELOG(\.[a-z]+)?$/i, 'changelog'],
  [/^LICEN[CS]E(\.[a-z]+)?$/i, 'license'],
  [/^(ROADMAP|TODO|PROJECT_STATUS|project_status|roadmap|STATUS)(\.[a-z]+)?$/, 'roadmap or status'],
];

const ENTRY_NAMES = /^(src\/)?(index|main|app|server|cli)\.(ts|tsx|js|mjs|py|go|rs|rb|php)$|^(main|app|manage|wsgi|asgi)\.py$|^cmd\/[^/]+\/main\.go$|^src\/main\.rs$|^src\/lib\.rs$/;

function readGit(root: string): ProjectBaseline['git'] {
  const head = path.join(root, '.git', 'HEAD');
  if (!existsSync(path.join(root, '.git'))) return { repository: false };
  try {
    const text = readFileSync(head, 'utf8').trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(text);
    return { repository: true, branch: match ? match[1] : undefined };
  } catch {
    return { repository: true };
  }
}

/** Looks at the workspace and reports only what the files show. */
export async function inspectProject(index: WorkspaceIndex, name: string): Promise<ProjectBaseline> {
  await index.refresh();
  const files = index.files();
  const facts = await detectProject(index);

  const existingDocs: ExistingDoc[] = [];
  for (const file of files) {
    for (const [pattern, kind] of DOC_FILES) if (pattern.test(file.path)) existingDocs.push({ path: file.path, kind });
  }
  if (files.some((f) => /^docs?\//i.test(f.path))) {
    existingDocs.push({ path: files.find((f) => /^docs?\//i.test(f.path))?.path.split('/')[0] + '/', kind: 'documentation folder' });
  }

  const declaredEntryPoints: ProjectBaseline['declaredEntryPoints'] = [];
  if (index.has('package.json')) {
    try {
      const pkg = JSON.parse((await index.readText('package.json')).text) as { main?: unknown; bin?: unknown; module?: unknown };
      const add = (value: unknown, field: string): void => {
        if (typeof value === 'string' && value.trim()) declaredEntryPoints.push({ path: value.replace(/^\.\//, ''), source: `package.json "${field}"` });
      };
      add(pkg.main, 'main');
      add(pkg.module, 'module');
      if (typeof pkg.bin === 'string') add(pkg.bin, 'bin');
      else if (pkg.bin && typeof pkg.bin === 'object') for (const value of Object.values(pkg.bin as Record<string, unknown>)) add(value, 'bin');
    } catch {
      // malformed manifest: nothing can be stated from it
    }
  }

  const likelyEntryPoints = files
    .map((f) => f.path)
    .filter((p) => ENTRY_NAMES.test(p) && !declaredEntryPoints.some((d) => d.path === p))
    .slice(0, 5);

  const testDirs = new Set<string>();
  for (const file of files) {
    const dir = /^(.*?(?:^|\/)(?:tests?|__tests__|spec|specs|e2e))\//.exec(file.path);
    if (dir) testDirs.add(`${dir[1]}/`);
    else if (/[._-](test|spec)\.[a-z0-9]+$/i.test(file.path) || /(^|\/)test_[^/]+\.py$/.test(file.path)) {
      testDirs.add(file.path.includes('/') ? `${file.path.slice(0, file.path.lastIndexOf('/'))}/` : './');
    }
  }

  let readmeExcerpt: string | undefined;
  const readme = existingDocs.find((d) => d.kind === 'readme');
  if (readme) {
    try {
      const text = (await index.readText(readme.path)).text;
      const paragraph = text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .find((p) => p && !p.startsWith('#') && !p.startsWith('![') && !p.startsWith('<') && !p.startsWith('[!['));
      if (paragraph) readmeExcerpt = paragraph.replace(/\s+/g, ' ').slice(0, 400);
    } catch {
      // unreadable readme
    }
  }

  const sourceFileCount = files.filter((f) => SOURCE_EXT.has(f.ext)).length;
  const knowledge = [CONTEXT_FILE, STATUS_FILE, ROADMAP_FILE, DECISIONS_FILE, IGNORE_FILE];
  return {
    name,
    kind: sourceFileCount === 0 ? 'new' : 'existing',
    facts,
    fileCount: files.length,
    sourceFileCount,
    scanTruncated: index.stats?.truncated ?? false,
    git: readGit(index.root),
    existingDocs: existingDocs.filter((d, i, all) => all.findIndex((o) => o.path === d.path) === i).sort((a, b) => a.path.localeCompare(b.path)),
    existingKnowledge: knowledge.filter((p) => existsSync(path.join(index.root, ...p.split('/')))),
    declaredEntryPoints,
    likelyEntryPoints,
    testLocations: [...testDirs].sort().slice(0, 8),
    readmeExcerpt,
  };
}

function header(title: string, date: string, note: string): string {
  return `# ${title}\n\n> Created by ByteAgent on ${date} from the files in this workspace. ${note}\n`;
}

export function renderContext(baseline: ProjectBaseline, date: string, requirements?: string): string {
  const { facts } = baseline;
  const discovered: string[] = [];
  const inferred: string[] = [];
  const unknown: string[] = [];

  if (facts.languages.length > 0) discovered.push(`Languages: ${facts.languages.map((l) => `${l.name} (${l.files} file${l.files === 1 ? '' : 's'})`).join(', ')}. Source: file extensions.`);
  if (facts.frameworks.length > 0) discovered.push(`Frameworks and tools: ${facts.frameworks.join(', ')}. Source: ${facts.manifests.join(', ')}.`);
  if (facts.packageManagers.length > 0) discovered.push(`Package manager: ${facts.packageManagers.join(', ')}. Source: manifest and lock files.`);
  if (facts.testCommands.length > 0) discovered.push(`Test command: ${facts.testCommands.map((c) => `\`${c}\``).join(', ')}. Source: project manifest.`);
  if (facts.buildCommands.length > 0) discovered.push(`Build command: ${facts.buildCommands.map((c) => `\`${c}\``).join(', ')}. Source: project manifest.`);
  if (facts.lintCommands.length > 0) discovered.push(`Check command: ${facts.lintCommands.map((c) => `\`${c}\``).join(', ')}. Source: project manifest.`);
  if (facts.topLevel.length > 0) discovered.push(`Top-level layout: ${facts.topLevel.join(' ')}`);
  discovered.push(`Files available to ByteAgent: ${baseline.fileCount}${baseline.scanTruncated ? ' (the scan stopped at its limit, so there are more)' : ''}, of which ${baseline.sourceFileCount} are source files.`);
  discovered.push(baseline.git.repository ? `Git repository: yes${baseline.git.branch ? `, on branch \`${baseline.git.branch}\`` : ''}.` : 'Git repository: no `.git` folder was found.');
  for (const entry of baseline.declaredEntryPoints) discovered.push(`Entry point: \`${entry.path}\`. Source: ${entry.source}.`);
  if (baseline.existingDocs.length > 0) discovered.push(`Existing documents: ${baseline.existingDocs.map((d) => `\`${d.path}\` (${d.kind})`).join(', ')}.`);

  for (const entry of baseline.likelyEntryPoints) inferred.push(`\`${entry}\` is probably an entry point (conventional file name).`);
  if (baseline.testLocations.length > 0) inferred.push(`Tests appear to live in ${baseline.testLocations.map((t) => `\`${t}\``).join(', ')} (file and folder names).`);
  if (baseline.readmeExcerpt) inferred.push(`Purpose, as described by the README (not checked against the code): "${baseline.readmeExcerpt}"`);

  if (facts.testCommands.length === 0) unknown.push('How to run the tests: no test command was found in a manifest.');
  else unknown.push('Whether the tests currently pass: they have not been run by ByteAgent.');
  if (facts.buildCommands.length === 0) unknown.push('How to build the project.');
  if (baseline.declaredEntryPoints.length === 0 && baseline.likelyEntryPoints.length === 0) unknown.push('Where the program starts.');
  unknown.push('What each module is responsible for, beyond what the folder names suggest.');
  unknown.push('How the project is deployed and which environments exist.');
  unknown.push('Which parts of the existing documents are still accurate.');

  const list = (items: string[], empty: string): string => (items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : empty);
  const sections = [
    header('Project Context', date, 'Edit it freely: ByteAgent reads this file with every larger task and never overwrites it.'),
    requirements?.trim() ? `## Stated requirements\n\nGiven by the developer when the project was set up:\n\n${requirements.trim()}\n` : '',
    `## Discovered facts\n\nEach line comes from a file that exists in the workspace.\n\n${list(discovered, 'Nothing could be established: the workspace has no recognisable project files yet.')}\n`,
    `## Inferences\n\nReasonable guesses that nobody has confirmed. Correct or delete them.\n\n${list(inferred, 'None.')}\n`,
    `## Unknown\n\nByteAgent could not determine these from the files:\n\n${list(unknown, 'None.')}\n`,
    '## Notes for agents\n\nAdd project knowledge here that every request should take into account: architecture, conventions, things that must not be changed.\n',
  ];
  return sections.filter(Boolean).join('\n');
}

export function renderStatus(baseline: ProjectBaseline, date: string): string {
  return [
    header('Project Status', date, 'It records what has actually been verified. Planned work belongs in `roadmap.md`.'),
    '## Verified by ByteAgent\n\nNothing yet. ByteAgent has not run any test, build or check in this project.\n',
    `## Tracked tasks\n\nThis section is kept in step with ByteAgent's task records. Text outside the markers is yours.\n\n${TASKS_START}\nNo tracked tasks yet.\n${TASKS_END}\n`,
    baseline.kind === 'existing'
      ? '## Not verified\n\n- Features described in the README or other documents have not been checked against the code.\n- The state of the existing code has not been assessed.\n'
      : '## Not verified\n\n- The project has no source files yet, so there is nothing to verify.\n',
  ].join('\n');
}

/** Turns free-form requirements into separate proposed items without adding any. */
export function requirementItems(requirements: string): string[] {
  const lines = requirements
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0);
  const items = lines.length > 1 ? lines : requirements.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return items.slice(0, 30).map((i) => i.replace(/\s+/g, ' ').slice(0, 200));
}

export function renderRoadmap(baseline: ProjectBaseline, date: string, requirements?: string): string {
  const items = requirements?.trim() ? requirementItems(requirements) : [];
  const proposed =
    items.length > 0
      ? `These items restate the requirements given at setup. They are proposals until you confirm them.\n\n${items
          .map((item, i) => `### R-${String(i + 1).padStart(3, '0')}\n- Title: ${item}\n- Status: proposed\n`)
          .join('\n')}`
      : baseline.kind === 'existing'
        ? 'No roadmap was found in this project, and ByteAgent has not invented one. Add planned work below, or ask ByteAgent to propose items for a goal you describe.\n'
        : 'No requirements were given. Add planned work below.\n';
  return [
    header('Roadmap', date, 'A roadmap lists planned work. An item here is not proof that anything is implemented.'),
    `## Proposed\n\n${proposed}`,
    '## Format\n\n```\n### R-001\n- Title:\n- Description:\n- Priority:\n- Status: proposed | planned | in progress | done\n```\n',
  ].join('\n');
}

export function renderDecisions(date: string): string {
  return [
    header('Decisions', date, 'Record confirmed architectural decisions here. ByteAgent does not add entries on its own.'),
    'No decisions have been recorded.\n',
    '## Format\n\n```\n## D-001: Short title\n- Date:\n- Decision:\n- Reason:\n```\n',
  ].join('\n');
}

export function renderAgentsFile(baseline: ProjectBaseline): string {
  const { facts } = baseline;
  const commands = [
    ...facts.testCommands.map((c) => `- Tests: \`${c}\``),
    ...facts.lintCommands.map((c) => `- Checks: \`${c}\``),
    ...facts.buildCommands.map((c) => `- Build: \`${c}\``),
  ];
  return [
    '# Agent Operating Guide\n',
    'Rules for AI coding agents working in this repository. Edit them to match how your team works.\n',
    '## Read first\n\n1. `README.md`\n2. `.byteagent/context.md`\n3. `.byteagent/project_status.md`\n4. `.byteagent/roadmap.md`\n',
    '## Source of truth\n\n1. The code\n2. `.byteagent/project_status.md`\n3. `.byteagent/context.md`\n4. `.byteagent/roadmap.md`\n\nRoadmap items are plans. Never assume they are implemented.\n',
    '## Working rules\n\n- Make small, reviewable changes.\n- Run the relevant checks and report the actual results.\n- Never claim a test passed unless it ran.\n- Do not commit, push or change databases without being asked.\n',
    commands.length > 0 ? `## Commands\n\n${commands.join('\n')}\n` : '## Commands\n\nNo test or build commands were found. Add them here.\n',
  ].join('\n');
}

export interface OnboardingOptions {
  name: string;
  /** Free-form requirements, used for a new project. */
  requirements?: string;
  /** Create AGENTS.md too. Only on explicit request, and never over an existing file. */
  includeAgentsFile?: boolean;
  date?: string;
}

export interface OnboardingPlan {
  baseline: ProjectBaseline;
  /** Files to create. Existing files are never part of this. */
  operations: ChangeOperation[];
  /** Files that already exist and are left untouched. */
  kept: string[];
}

/**
 * Prepares the knowledge files for a project. Only missing files are
 * proposed; anything the developer already has is kept as it is. The
 * result still goes through the normal change review before it is written.
 */
export async function planOnboarding(index: WorkspaceIndex, options: OnboardingOptions): Promise<OnboardingPlan> {
  const baseline = await inspectProject(index, options.name);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const wanted: Array<[string, () => string]> = [
    [CONTEXT_FILE, () => renderContext(baseline, date, options.requirements)],
    [STATUS_FILE, () => renderStatus(baseline, date)],
    [ROADMAP_FILE, () => renderRoadmap(baseline, date, options.requirements)],
    [DECISIONS_FILE, () => renderDecisions(date)],
    [IGNORE_FILE, () => '# ByteAgent local data. Keep this out of version control.\nagent.db\nagent.db.*\n'],
  ];
  if (options.includeAgentsFile) wanted.push(['AGENTS.md', () => renderAgentsFile(baseline)]);

  const operations: ChangeOperation[] = [];
  const kept: string[] = [];
  for (const [file, render] of wanted) {
    if (existsSync(path.join(index.root, ...file.split('/')))) kept.push(file);
    else operations.push({ type: 'write', path: file, content: render() });
  }
  return { baseline, operations, kept };
}

/** A short, honest description of what was found, shown before the review. */
export function describeBaseline(plan: OnboardingPlan): string {
  const { baseline } = plan;
  const lines: string[] = [];
  if (baseline.kind === 'new') {
    lines.push(`**${baseline.name || 'This workspace'}** has no source files yet, so I prepared the knowledge files for a new project.`);
  } else {
    const stack = [...baseline.facts.languages.slice(0, 3).map((l) => l.name), ...baseline.facts.frameworks.slice(0, 4)];
    lines.push(`I scanned **${baseline.name || 'this workspace'}**: ${baseline.fileCount} files${stack.length > 0 ? `, mainly ${[...new Set(stack)].join(', ')}` : ''}.`);
    if (baseline.facts.testCommands.length > 0) lines.push(`Test command found: \`${baseline.facts.testCommands[0]}\`. I have not run it.`);
    else lines.push('I found no test command.');
  }
  if (baseline.existingDocs.length > 0) lines.push(`Your existing documents (${baseline.existingDocs.map((d) => `\`${d.path}\``).join(', ')}) are left untouched.`);
  if (plan.kept.length > 0) lines.push(`Already present and kept as they are: ${plan.kept.map((k) => `\`${k}\``).join(', ')}.`);
  if (plan.operations.length > 0) {
    lines.push('The files below separate what I found in the code from what I am guessing and what I could not determine. The roadmap contains no invented items. Review them before they are written.');
  } else lines.push('Project knowledge is already set up. Nothing needs to be created.');
  return lines.join('\n\n');
}
