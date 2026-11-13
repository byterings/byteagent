import type { WorkspaceIndex } from './workspaceIndex';

export interface ProjectFacts {
  languages: Array<{ name: string; files: number }>;
  frameworks: string[];
  packageManagers: string[];
  manifests: string[];
  testCommands: string[];
  buildCommands: string[];
  lintCommands: string[];
  topLevel: string[];
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  dart: 'Dart', scala: 'Scala', sh: 'Shell', sql: 'SQL', vue: 'Vue', svelte: 'Svelte',
  html: 'HTML', css: 'CSS', scss: 'CSS',
};

const NODE_FRAMEWORKS: Array<[string, string]> = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['@angular/core', 'Angular'], ['svelte', 'Svelte'],
  ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['koa', 'Koa'], ['hono', 'Hono'],
  ['vite', 'Vite'], ['webpack', 'webpack'], ['electron', 'Electron'], ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'],
  ['typeorm', 'TypeORM'], ['mongoose', 'Mongoose'], ['tailwindcss', 'Tailwind CSS'],
  ['jest', 'Jest'], ['vitest', 'Vitest'], ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'], ['cypress', 'Cypress'],
  ['eslint', 'ESLint'], ['typescript', 'TypeScript compiler'],
];

const PYTHON_FRAMEWORKS: Array<[RegExp, string]> = [
  [/\bdjango\b/i, 'Django'], [/\bflask\b/i, 'Flask'], [/\bfastapi\b/i, 'FastAPI'], [/\bpytest\b/i, 'pytest'],
  [/\bsqlalchemy\b/i, 'SQLAlchemy'], [/\bnumpy\b/i, 'NumPy'], [/\bpandas\b/i, 'pandas'],
];

async function read(index: WorkspaceIndex, path: string): Promise<string | undefined> {
  if (!index.has(path)) return undefined;
  try {
    return (await index.readText(path)).text;
  } catch {
    return undefined;
  }
}

function add(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Detects the project's stack from manifests and file extensions. Every
 * fact comes from a file that exists; nothing is guessed.
 */
export async function detectProject(index: WorkspaceIndex): Promise<ProjectFacts> {
  await index.ensureFresh();
  const files = index.files();
  const facts: ProjectFacts = {
    languages: [],
    frameworks: [],
    packageManagers: [],
    manifests: [],
    testCommands: [],
    buildCommands: [],
    lintCommands: [],
    topLevel: [],
  };

  const counts = new Map<string, number>();
  const top = new Set<string>();
  for (const file of files) {
    const language = LANGUAGE_BY_EXT[file.ext];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    const slash = file.path.indexOf('/');
    top.add(slash === -1 ? file.path : `${file.path.slice(0, slash)}/`);
  }
  facts.languages = [...counts.entries()]
    .map(([name, n]) => ({ name, files: n }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 6);
  facts.topLevel = [...top].sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b)).slice(0, 30);

  const has = (name: string): boolean => index.has(name);

  const pkgText = await read(index, 'package.json');
  if (pkgText) {
    facts.manifests.push('package.json');
    const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    add(facts.packageManagers, runner);
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dep, label] of NODE_FRAMEWORKS) if (dep in deps) add(facts.frameworks, label);
      const scripts = pkg.scripts ?? {};
      const run = (script: string): string => (runner === 'npm' ? (script === 'test' ? 'npm test' : `npm run ${script}`) : `${runner} ${script === 'test' ? 'test' : `run ${script}`}`);
      for (const name of Object.keys(scripts)) {
        const body = scripts[name] ?? '';
        if (/no test specified/.test(body)) continue;
        if (name === 'test' || /^test[:-]?(unit|ci)?$/.test(name)) add(facts.testCommands, run(name));
        else if (name === 'build' || name === 'compile') add(facts.buildCommands, run(name));
        else if (name === 'lint' || name === 'typecheck' || name === 'check') add(facts.lintCommands, run(name));
      }
    } catch {
      // Malformed package.json: the file exists, its contents are unknown.
    }
  }

  const python = [await read(index, 'pyproject.toml'), await read(index, 'requirements.txt'), await read(index, 'setup.py'), await read(index, 'Pipfile')];
  const pythonNames = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'];
  python.forEach((text, i) => {
    if (text === undefined) return;
    facts.manifests.push(pythonNames[i] as string);
    for (const [pattern, label] of PYTHON_FRAMEWORKS) if (pattern.test(text)) add(facts.frameworks, label);
  });
  if (python.some((t) => t !== undefined)) {
    add(facts.packageManagers, has('poetry.lock') ? 'poetry' : has('uv.lock') ? 'uv' : has('Pipfile') ? 'pipenv' : 'pip');
    if (facts.frameworks.includes('pytest') || has('pytest.ini') || files.some((f) => /(^|\/)test_[^/]+\.py$/.test(f.path))) {
      add(facts.testCommands, 'pytest');
    }
    if (has('manage.py')) add(facts.testCommands, 'python manage.py test');
  }

  if (has('go.mod')) {
    facts.manifests.push('go.mod');
    add(facts.packageManagers, 'go modules');
    add(facts.testCommands, 'go test ./...');
    add(facts.buildCommands, 'go build ./...');
  }
  if (has('Cargo.toml')) {
    facts.manifests.push('Cargo.toml');
    add(facts.packageManagers, 'cargo');
    add(facts.testCommands, 'cargo test');
    add(facts.buildCommands, 'cargo build');
  }
  if (has('pom.xml')) {
    facts.manifests.push('pom.xml');
    add(facts.packageManagers, 'maven');
    add(facts.testCommands, 'mvn test');
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    facts.manifests.push(has('build.gradle') ? 'build.gradle' : 'build.gradle.kts');
    add(facts.packageManagers, 'gradle');
    add(facts.testCommands, has('gradlew') ? './gradlew test' : 'gradle test');
  }
  if (has('Gemfile')) {
    facts.manifests.push('Gemfile');
    add(facts.packageManagers, 'bundler');
    const gemfile = (await read(index, 'Gemfile')) ?? '';
    if (/rails/.test(gemfile)) add(facts.frameworks, 'Rails');
    if (/rspec/.test(gemfile)) add(facts.testCommands, 'bundle exec rspec');
  }
  if (has('composer.json')) {
    facts.manifests.push('composer.json');
    add(facts.packageManagers, 'composer');
    const composer = (await read(index, 'composer.json')) ?? '';
    if (/laravel\/framework/.test(composer)) add(facts.frameworks, 'Laravel');
    if (/phpunit/.test(composer)) add(facts.testCommands, 'vendor/bin/phpunit');
  }
  const csproj = files.find((f) => f.ext === 'csproj' || f.ext === 'sln');
  if (csproj) {
    facts.manifests.push(csproj.path);
    add(facts.packageManagers, 'dotnet');
    add(facts.testCommands, 'dotnet test');
    add(facts.buildCommands, 'dotnet build');
  }

  const makefile = await read(index, 'Makefile');
  if (makefile !== undefined) {
    facts.manifests.push('Makefile');
    if (/^test:/m.test(makefile)) add(facts.testCommands, 'make test');
    if (/^build:/m.test(makefile)) add(facts.buildCommands, 'make build');
    if (/^lint:/m.test(makefile)) add(facts.lintCommands, 'make lint');
  }
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml')) add(facts.frameworks, 'Docker');
  if (has('tsconfig.json') && !facts.manifests.includes('tsconfig.json')) facts.manifests.push('tsconfig.json');

  return facts;
}

/** A few lines for the system prompt. Empty when nothing was detected. */
export function summarizeFacts(facts: ProjectFacts): string {
  const lines: string[] = [];
  if (facts.languages.length > 0) lines.push(`Languages: ${facts.languages.map((l) => `${l.name} (${l.files} files)`).join(', ')}`);
  if (facts.frameworks.length > 0) lines.push(`Frameworks and tools: ${facts.frameworks.join(', ')}`);
  if (facts.packageManagers.length > 0) lines.push(`Package managers: ${facts.packageManagers.join(', ')}`);
  if (facts.testCommands.length > 0) lines.push(`Test commands: ${facts.testCommands.join(' | ')}`);
  if (facts.buildCommands.length > 0) lines.push(`Build commands: ${facts.buildCommands.join(' | ')}`);
  if (facts.lintCommands.length > 0) lines.push(`Check commands: ${facts.lintCommands.join(' | ')}`);
  if (facts.topLevel.length > 0) lines.push(`Top level: ${facts.topLevel.join(' ')}`);
  return lines.join('\n');
}
