import ignore from 'ignore';
import { SENSITIVE_PATTERNS } from '../context/ignore';
import type { CommandRisk } from '../shared/protocol';

export interface CommandAssessment {
  risk: CommandRisk;
  /** Why the command is not "safe". Empty for safe commands. */
  reasons: string[];
  /** Whether "always allow" may be offered for this exact command. */
  canRemember: boolean;
  /** True when the command only checks the project (tests, lint, type check, build). */
  isCheck: boolean;
}

const ORDER: Record<CommandRisk, number> = { safe: 0, moderate: 1, destructive: 2 };

const sensitive = ignore().add(SENSITIVE_PATTERNS);

interface Segment {
  words: string[];
  raw: string;
}

interface Parsed {
  segments: Segment[];
  chained: boolean;
  substitution: boolean;
  redirection: boolean;
  background: boolean;
}

/** Splits a shell command into simple commands, respecting quotes. */
export function parseCommand(command: string): Parsed {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = '';
  let hasWord = false;
  let raw = '';
  let quote: '"' | "'" | null = null;
  const parsed: Parsed = { segments, chained: false, substitution: false, redirection: false, background: false };

  const endWord = (): void => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) segments.push({ words, raw: raw.trim() });
    words = [];
    raw = '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    const next = command[i + 1];
    if (quote) {
      raw += ch;
      if (ch === quote) quote = null;
      else {
        if (quote === '"' && (ch === '`' || (ch === '$' && next === '('))) parsed.substitution = true;
        if (quote === '"' && ch === '\\' && next !== undefined) {
          word += next;
          raw += next;
          i += 1;
        } else word += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasWord = true;
      raw += ch;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      word += next;
      hasWord = true;
      raw += ch + next;
      i += 1;
      continue;
    }
    if (ch === '`' || (ch === '$' && next === '(')) parsed.substitution = true;
    if (ch === '\n' || ch === ';') {
      parsed.chained = true;
      endSegment();
      continue;
    }
    if (ch === '&' && next === '&') {
      parsed.chained = true;
      endSegment();
      i += 1;
      continue;
    }
    if (ch === '|') {
      parsed.chained = true;
      endSegment();
      if (next === '|' || next === '&') i += 1;
      continue;
    }
    if (ch === '&') {
      if (next === '>') {
        parsed.redirection = true;
        raw += ch;
        continue;
      }
      parsed.background = true;
      parsed.chained = true;
      endSegment();
      continue;
    }
    if (ch === '>' || ch === '<') {
      // "2>&1" style duplication writes no file; everything else may.
      const rest = command.slice(i, i + 3);
      if (/^>&\d/.test(rest)) {
        raw += rest;
        word = '';
        hasWord = false;
        i += 2;
        continue;
      }
      if (!(ch === '<' && next === '<')) parsed.redirection = parsed.redirection || ch === '>';
      raw += ch;
      endWord();
      continue;
    }
    if (/\s/.test(ch)) {
      raw += ch;
      endWord();
      continue;
    }
    word += ch;
    hasWord = true;
    raw += ch;
  }
  endSegment();
  return parsed;
}

const READ_ONLY = new Set([
  'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'tree', 'stat', 'file', 'du', 'df',
  'echo', 'printf', 'which', 'whereis', 'type', 'date', 'whoami', 'uname', 'hostname', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename',
  'dirname', 'realpath', 'readlink', 'true', 'false', 'test', 'sleep', 'jq', 'yq', 'column', 'nl', 'less', 'more', 'md5sum', 'sha256sum',
]);

const CHECK_RUNNERS = new Set([
  'pytest', 'jest', 'vitest', 'mocha', 'ava', 'tap', 'tsc', 'eslint', 'ruff', 'mypy', 'pyright', 'flake8', 'pylint', 'phpunit', 'rspec',
  'rubocop', 'golangci-lint', 'staticcheck', 'shellcheck', 'stylelint', 'biome', 'oxlint', 'tox', 'nox', 'ctest', 'deno',
]);

const SAFE_SCRIPT = /^(test|tests|lint|typecheck|type-check|check|build|compile|format:check|fmt:check|verify|validate|ci)([:._-][\w:.-]+)?$/;

const MOVES_LOCAL = new Set(['mv', 'cp', 'mkdir', 'touch', 'ln', 'tee', 'chmod', 'chown', 'chgrp', 'patch', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'kill', 'pkill', 'killall', 'xargs', 'install']);

const REMOTE_OR_INFRA = new Set([
  'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'ansible', 'ansible-playbook', 'aws', 'gcloud', 'az',
  'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'heroku', 'vercel', 'netlify', 'fly', 'flyctl', 'doctl', 'gh', 'glab',
]);

const DATABASE = new Set(['psql', 'mysql', 'mariadb', 'mongosh', 'mongo', 'sqlite3', 'redis-cli', 'sqlcmd', 'cqlsh', 'pg_restore', 'pg_dump', 'mysqldump', 'dropdb', 'createdb']);

const SYSTEM = new Set(['dd', 'mkfs', 'fdisk', 'parted', 'shutdown', 'reboot', 'halt', 'poweroff', 'systemctl', 'service', 'launchctl', 'crontab', 'mount', 'umount', 'iptables', 'useradd', 'userdel', 'passwd', 'format', 'diskpart']);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd']);

interface Verdict {
  risk: CommandRisk;
  reason?: string;
  check?: boolean;
}

const safe = (check = false): Verdict => ({ risk: 'safe', check });
const moderate = (reason: string): Verdict => ({ risk: 'moderate', reason });
const destructive = (reason: string): Verdict => ({ risk: 'destructive', reason });

function programName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|sh)$/i, '').toLowerCase();
}

function hasFlag(words: string[], ...flags: string[]): boolean {
  return words.some((w) => flags.includes(w) || (w.startsWith('-') && !w.startsWith('--') && flags.some((f) => f.length === 2 && w.includes(f[1] as string))));
}

function assessGit(args: string[]): Verdict {
  const rest = args.filter((a) => !a.startsWith('-') || a === '--');
  const sub = rest[0] ?? '';
  const flags = args.filter((a) => a.startsWith('-'));
  const has = (...names: string[]): boolean => flags.some((f) => names.includes(f) || names.some((n) => n.startsWith('--') && f.startsWith(`${n}=`)));

  if (['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'grep', 'cat-file', 'reflog', 'whatchanged', 'version', '--version'].includes(sub) || sub === '') {
    return safe();
  }
  if (sub === 'branch') {
    if (has('-D', '--delete', '-d', '-M', '-m', '--force', '-f')) return destructive('Deletes or renames a Git branch');
    return rest.length > 1 ? moderate('Creates a Git branch') : safe();
  }
  if (sub === 'remote') return rest.length <= 1 || rest[1] === 'show' || rest[1] === 'get-url' ? safe() : moderate('Changes Git remotes');
  if (sub === 'tag') return rest.length <= 1 ? safe() : has('-d', '--delete') ? destructive('Deletes a Git tag') : moderate('Creates a Git tag');
  if (sub === 'stash') {
    const action = rest[1] ?? 'push';
    if (action === 'list' || action === 'show') return safe();
    if (action === 'drop' || action === 'clear') return destructive('Discards stashed work');
    return moderate('Moves uncommitted work into the Git stash');
  }
  if (sub === 'config') return has('--get', '--list', '-l', '--get-all') || rest.length === 2 ? safe() : moderate('Changes Git configuration');
  if (sub === 'push') return destructive(has('--force', '-f', '--force-with-lease') ? 'Force-pushes to a remote repository' : 'Pushes commits to a remote repository');
  if (sub === 'reset') return has('--hard') ? destructive('Discards uncommitted changes (git reset --hard)') : moderate('Moves the current branch or unstages files');
  if (sub === 'clean') return destructive('Deletes untracked files (git clean)');
  if (sub === 'checkout' || sub === 'restore' || sub === 'switch') {
    if (sub === 'restore' || has('--force', '-f', '--discard-changes') || args.includes('--') || args.includes('.')) {
      return destructive('May discard uncommitted changes');
    }
    return moderate('Switches branches or files');
  }
  if (['rebase', 'filter-branch', 'filter-repo', 'gc', 'prune', 'update-ref'].includes(sub)) return destructive('Rewrites Git history or removes objects');
  if (sub === 'commit') return has('--amend') ? destructive('Rewrites the last commit') : moderate('Creates a Git commit');
  if (['add', 'rm', 'mv', 'merge', 'pull', 'fetch', 'cherry-pick', 'revert', 'apply', 'am', 'init', 'clone', 'submodule', 'worktree', 'bisect'].includes(sub)) {
    return sub === 'rm' ? destructive('Removes files from the working tree') : moderate(`Changes the repository (git ${sub})`);
  }
  return moderate(`Runs git ${sub}`);
}

function assessPackageManager(program: string, args: string[]): Verdict {
  const rest = args.filter((a) => !a.startsWith('-'));
  const sub = rest[0] ?? '';
  if (sub === '' || ['--version', '-v', 'help', 'ls', 'list', 'outdated', 'why', 'view', 'info', 'audit', 'config', 'bin', 'root', 'prefix', 'doctor', 'explain'].includes(sub)) {
    return args.includes('fix') ? moderate('Changes installed packages') : safe();
  }
  if (sub === 'test' || sub === 't' || sub === 'tst') return safe(true);
  if (sub === 'run' || sub === 'run-script') {
    const script = rest[1] ?? '';
    return SAFE_SCRIPT.test(script) ? safe(true) : moderate(`Runs the project script "${script || '?'}", whose effect is not known`);
  }
  if (sub === 'publish' || sub === 'unpublish' || sub === 'deprecate' || sub === 'login' || sub === 'logout' || sub === 'token' || sub === 'owner' || sub === 'access') {
    return destructive('Changes a package registry or its credentials');
  }
  if (['install', 'i', 'add', 'ci', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'dedupe', 'link', 'unlink', 'prune', 'rebuild', 'create', 'init', 'dlx', 'exec', 'x', 'import', 'patch'].includes(sub)) {
    return moderate(sub === 'exec' || sub === 'dlx' || sub === 'x' ? 'Downloads and runs a package' : 'Installs, removes or updates packages');
  }
  // yarn/pnpm/bun run scripts without the "run" word.
  if (program !== 'npm' && SAFE_SCRIPT.test(sub)) return safe(true);
  return moderate(`Runs ${program} ${sub}`);
}

function assessSegment(segment: Segment): Verdict[] {
  const verdicts: Verdict[] = [];
  let words = [...segment.words];

  // Leading VAR=value assignments.
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) words.shift();
  if (words.length === 0) return [safe()];

  let program = programName(words[0] as string);
  if (program === 'sudo' || program === 'doas' || program === 'su' || program === 'runas') {
    verdicts.push(destructive('Runs with elevated privileges'));
    words = words.slice(1).filter((w, i) => !(i === 0 && w.startsWith('-')));
    if (words.length === 0) return verdicts;
    program = programName(words[0] as string);
  }
  if (['env', 'time', 'nice', 'nohup', 'timeout', 'command', 'exec', 'stdbuf'].includes(program) && words.length > 1) {
    let rest = words.slice(1);
    if (program === 'timeout' && rest.length > 1) rest = rest.slice(1);
    while (rest.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] as string) || (rest[0] as string).startsWith('-'))) rest.shift();
    if (rest.length === 0) return [program === 'env' ? moderate('Prints environment variables, which may include secrets') : safe()];
    return [...verdicts, ...assessSegment({ words: rest, raw: rest.join(' ') })];
  }

  const args = words.slice(1);
  const lower = segment.raw.toLowerCase();

  // Arguments that name credential files, whatever the program.
  for (const arg of args) {
    const candidate = arg.replace(/^[-\w]+=/, '').replace(/^\.\//, '').replace(/^~\//, '');
    if (!candidate || candidate.startsWith('-') || /^[a-z]+:\/\//i.test(candidate)) continue;
    try {
      if (sensitive.ignores(candidate.replace(/^\/+/, '')) || /(^|\/)\.(ssh|aws|gnupg)(\/|$)/.test(candidate)) {
        verdicts.push(destructive(`Touches a sensitive file (${candidate})`));
        break;
      }
    } catch {
      // not a path
    }
  }

  if (/\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b/.test(lower)) verdicts.push(destructive('Contains a destructive SQL statement'));

  if (program === 'rm' || program === 'rmdir' || program === 'unlink' || program === 'shred' || program === 'del' || program === 'rd' || program === 'erase') {
    verdicts.push(destructive(hasFlag(args, '-r', '-R', '--recursive') ? 'Deletes files recursively (rm -r)' : 'Deletes files'));
  } else if (program === 'git') verdicts.push(assessGit(args));
  else if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) verdicts.push(assessPackageManager(program, args));
  else if (program === 'npx' || program === 'bunx' || program === 'pnpx') {
    const tool = programName(args.find((a) => !a.startsWith('-')) ?? '');
    const fixes = args.some((a) => a === '--fix' || a === '--write' || a === '-w');
    if (CHECK_RUNNERS.has(tool) || tool === 'prettier') verdicts.push(fixes ? moderate('Rewrites files in place') : tool === 'prettier' && !args.includes('--check') && !args.includes('-c') && !args.includes('-l') ? moderate('May print or rewrite files') : safe(true));
    else {
      verdicts.push(moderate(`Downloads and runs the package "${tool || '?'}"`));
      // The package may itself be something risky, such as a migration tool.
      const start = args.findIndex((a) => !a.startsWith('-'));
      if (start >= 0) verdicts.push(...assessSegment({ words: args.slice(start), raw: args.slice(start).join(' ') }).filter((v) => v.risk === 'destructive'));
    }
  } else if (CHECK_RUNNERS.has(program)) {
    const fixes = args.some((a) => a === '--fix' || a === '--write' || a === '-w' || a === '--fix-only' || a === '-a' || a === '--auto-correct');
    if (program === 'deno') verdicts.push(['test', 'check', 'lint'].includes(args[0] ?? '') ? safe(true) : moderate(`Runs deno ${args[0] ?? ''}`));
    else if (program === 'ruff' && args[0] === 'format' && !args.includes('--check')) verdicts.push(moderate('Rewrites files in place'));
    else verdicts.push(fixes ? moderate('Rewrites files in place') : safe(true));
  } else if (program === 'prettier') {
    verdicts.push(args.includes('--write') || args.includes('-w') ? moderate('Rewrites files in place') : safe(args.includes('--check') || args.includes('-c')));
  } else if (program === 'go') {
    const sub = args[0] ?? '';
    verdicts.push(['test', 'vet', 'build', 'version', 'list', 'doc', 'env'].includes(sub) ? safe(sub !== 'version' && sub !== 'list' && sub !== 'doc' && sub !== 'env') : moderate(`Runs go ${sub}`));
  } else if (program === 'cargo') {
    const sub = args.find((a) => !a.startsWith('+') && !a.startsWith('-')) ?? '';
    if (['test', 'check', 'clippy', 'build', 'doc', 'bench', 'tree', 'metadata', 'version', '--version'].includes(sub)) verdicts.push(safe(true));
    else if (sub === 'publish' || sub === 'login' || sub === 'yank') verdicts.push(destructive('Changes the crates registry or its credentials'));
    else verdicts.push(moderate(`Runs cargo ${sub}`));
  } else if (program === 'make' || program === 'just' || program === 'task') {
    const target = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? '';
    verdicts.push(SAFE_SCRIPT.test(target) ? safe(true) : moderate(`Runs the ${program} target "${target || 'default'}", whose effect is not known`));
  } else if (program === 'dotnet') {
    verdicts.push(['test', 'build', '--version', '--info'].includes(args[0] ?? '') ? safe(true) : moderate(`Runs dotnet ${args[0] ?? ''}`));
  } else if (program === 'mvn' || program === 'mvnw' || program === 'gradle' || program === 'gradlew') {
    const goals = args.filter((a) => !a.startsWith('-'));
    if (goals.some((g) => /deploy|publish|release/.test(g))) verdicts.push(destructive('Publishes build artifacts'));
    else verdicts.push(goals.length > 0 && goals.every((g) => /^(test|check|build|compile|verify|assemble|clean|lint|package)$/.test(g)) ? safe(true) : moderate(`Runs ${program} ${goals.join(' ')}`.trim()));
  } else if (program === 'python' || program === 'python3' || program === 'py' || program === 'node' || program === 'ruby' || program === 'php' || program === 'perl' || program === 'java' || program === 'bun' || program === 'tsx' || program === 'ts-node') {
    if (args.length === 0 || args.every((a) => ['--version', '-V', '-v', '--help', '-h'].includes(a))) verdicts.push(safe());
    else if ((program === 'python' || program === 'python3' || program === 'py') && args[0] === '-m' && ['pytest', 'unittest', 'mypy', 'ruff', 'flake8', 'pylint', 'pyright', 'compileall', 'py_compile'].includes(args[1] ?? '')) verdicts.push(safe(true));
    else if (program === 'node' && args[0] === '--test') verdicts.push(safe(true));
    else if (args[0] === 'manage.py' || args[1] === 'manage.py') {
      const sub = args[args.indexOf('manage.py') + 1] ?? '';
      verdicts.push(sub === 'test' || sub === 'check' ? safe(true) : /migrate|flush|loaddata|sqlflush|dbshell|createsuperuser/.test(sub) ? destructive('Changes the database') : moderate(`Runs manage.py ${sub}`));
    } else if (args[0] === '-c' || args[0] === '-e' || args[0] === '--eval') verdicts.push(moderate('Runs inline code'));
    else verdicts.push(moderate(`Runs a script with ${program}`));
  } else if (program === 'pip' || program === 'pip3' || program === 'poetry' || program === 'uv' || program === 'pipenv' || program === 'conda' || program === 'gem' || program === 'bundle' || program === 'composer' || program === 'brew' || program === 'apt' || program === 'apt-get' || program === 'yum' || program === 'dnf' || program === 'pacman' || program === 'choco' || program === 'winget') {
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    if (['list', 'show', 'freeze', 'check', '--version', 'outdated', 'info', 'search', 'tree', 'env'].includes(sub) || sub === '') verdicts.push(safe());
    else if ((program === 'poetry' || program === 'uv' || program === 'pipenv' || program === 'bundle' || program === 'composer') && (sub === 'run' || sub === 'exec')) {
      const inner = args.slice(args.indexOf(sub) + 1);
      verdicts.push(...(inner.length > 0 ? assessSegment({ words: inner, raw: inner.join(' ') }) : [moderate(`Runs ${program} ${sub}`)]));
    } else if (sub === 'publish' || sub === 'push' || sub === 'upload') verdicts.push(destructive('Publishes a package'));
    else verdicts.push(moderate('Installs, removes or updates packages'));
  } else if (program === 'curl' || program === 'wget' || program === 'http' || program === 'nc' || program === 'ncat' || program === 'telnet') {
    const sends = args.some((a) => /^(-X|--request)$/.test(a)) && args.some((a) => /^(POST|PUT|PATCH|DELETE)$/i.test(a));
    const uploads = args.some((a) => /^(-d|--data.*|-F|--form|-T|--upload-file)$/.test(a));
    verdicts.push(sends || uploads ? destructive('Sends data to a remote server') : moderate('Makes a network request'));
  } else if (SHELLS.has(program)) verdicts.push(moderate(args.length === 0 ? 'Starts a shell' : 'Runs a shell script, whose effect is not known'));
  else if (program === 'eval' || program === 'source' || program === '.') verdicts.push(moderate('Runs code from a string or file'));
  else if (REMOTE_OR_INFRA.has(program)) verdicts.push(destructive(`Affects containers, infrastructure or remote systems (${program})`));
  else if (DATABASE.has(program) || /^(prisma|knex|sequelize|typeorm|alembic|flyway|liquibase|rake|rails|artisan|drizzle-kit)$/.test(program)) {
    const text = args.join(' ').toLowerCase();
    if (DATABASE.has(program) || /migrat|db:|seed|reset|push|drop|deploy/.test(text)) verdicts.push(destructive('May change a database'));
    else verdicts.push(moderate(`Runs ${program}`));
  } else if (SYSTEM.has(program)) verdicts.push(destructive(`Changes system state (${program})`));
  else if (program === 'sed' || program === 'perl' || program === 'awk') verdicts.push(hasFlag(args, '-i', '--in-place') || args.some((a) => /^-i/.test(a)) ? moderate('Edits files in place') : safe());
  else if (program === 'find' || program === 'fd') {
    verdicts.push(args.includes('-delete') ? destructive('Deletes the files it finds') : args.some((a) => /^-(exec|execdir|ok|x|X)$/.test(a)) ? moderate('Runs a command on the files it finds') : safe());
  } else if (program === 'printenv' || program === 'set' || program === 'export') verdicts.push(moderate('Prints or changes environment variables, which may include secrets'));
  else if (MOVES_LOCAL.has(program)) verdicts.push(moderate(`Changes local files or processes (${program})`));
  else if (READ_ONLY.has(program)) verdicts.push(safe());
  else verdicts.push(moderate(`"${program}" is not a command ByteAgent recognises`));

  return verdicts;
}

/**
 * Classifies a shell command before the user is asked to approve it.
 * Anything not recognised as harmless is at least "moderate".
 */
export function assessCommand(command: string): CommandAssessment {
  const trimmed = command.trim();
  if (!trimmed) return { risk: 'moderate', reasons: ['The command is empty'], canRemember: false, isCheck: false };

  const parsed = parseCommand(trimmed);
  const reasons: string[] = [];
  let risk: CommandRisk = 'safe';
  let allChecks = parsed.segments.length > 0;
  const raise = (level: CommandRisk, reason?: string): void => {
    if (ORDER[level] > ORDER[risk]) risk = level;
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  for (let i = 0; i < parsed.segments.length; i++) {
    const segment = parsed.segments[i] as Segment;
    const verdicts = assessSegment(segment);
    let segmentIsCheck = false;
    for (const v of verdicts) {
      if (v.risk !== 'safe') raise(v.risk, v.reason);
      if (v.check) segmentIsCheck = true;
    }
    if (!segmentIsCheck || verdicts.some((v) => v.risk !== 'safe')) allChecks = false;

    // Piping a download into an interpreter runs unreviewed remote code.
    const program = programName(segment.words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? '');
    const previous = i > 0 ? programName((parsed.segments[i - 1] as Segment).words[0] ?? '') : '';
    if ((SHELLS.has(program) || ['python', 'python3', 'node', 'ruby', 'perl', 'php'].includes(program)) && ['curl', 'wget', 'http'].includes(previous)) {
      raise('destructive', 'Downloads a script and runs it immediately');
    }
  }

  if (parsed.substitution) raise('moderate', 'Contains command substitution, which hides part of what runs');
  if (parsed.redirection) raise('moderate', 'Writes output to a file');
  if (parsed.background) raise('moderate', 'Starts a background process');
  if (parsed.chained && parsed.segments.length > 1 && risk !== 'safe') reasons.push('Chains several commands');
  if (parsed.segments.length === 0) raise('moderate', 'The command could not be understood');

  const simple = !parsed.chained && !parsed.substitution && !parsed.redirection && !parsed.background;
  return { risk, reasons: risk === 'safe' ? [] : reasons, canRemember: risk === 'safe' && simple, isCheck: risk === 'safe' && allChecks };
}
