import ignore, { type Ignore } from 'ignore';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export type BlockReason = 'vcs' | 'default' | 'gitignore' | 'excluded' | 'sensitive';

export interface PathDecision {
  allowed: boolean;
  reason?: BlockReason;
}

/**
 * Files that commonly hold credentials. They are never indexed, read,
 * searched or changed, whether or not the project ignores them.
 */
export const SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '!.env.defaults',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  '*.secret',
  '*.secrets',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.htpasswd',
  '.pgpass',
  'credentials.json',
  'credentials.yml',
  'credentials.yaml',
  'secrets.*',
  'secret.*',
  'service-account*.json',
  '*.tfvars',
  'terraform.tfstate',
  'terraform.tfstate.*',
  '.aws/',
  '.ssh/',
  '.gnupg/',
  '.docker/config.json',
];

/** Directories that are never useful as context, even without a .gitignore. */
export const DEFAULT_EXCLUDES = [
  'node_modules/',
  'bower_components/',
  '.hg/',
  '.svn/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.gradle/',
  '.idea/',
  '.vscode-test/',
  '.DS_Store',
  'Thumbs.db',
  '.byteagent/agent.db',
  '.byteagent/agent.db-journal',
];

export interface PathPolicyOptions {
  /** Extra gitignore-style patterns from settings. */
  exclude?: string[];
  /** Set to false to ignore .gitignore files (used only in tests). */
  useGitignore?: boolean;
}

/**
 * Decides whether the agent may see a workspace path. The same policy is
 * used by the scanner, search, file reads, and change validation.
 */
export class PathPolicy {
  private readonly sensitive: Ignore = ignore().add(SENSITIVE_PATTERNS);
  private readonly defaults: Ignore = ignore().add(DEFAULT_EXCLUDES);
  private readonly user: Ignore;
  private readonly useGitignore: boolean;
  /** .gitignore rules per directory ('' is the root); undefined means no file there. */
  private readonly gitignores = new Map<string, Ignore | undefined>();

  constructor(
    private readonly root: string,
    options: PathPolicyOptions = {},
  ) {
    this.user = ignore().add((options.exclude ?? []).filter((p) => p.trim().length > 0));
    this.useGitignore = options.useGitignore !== false;
  }

  /** `relative` uses forward slashes and has no leading slash. */
  check(relative: string, isDirectory = false): PathDecision {
    const rel = relative.replace(/^\.\//, '').replace(/\/+$/, '');
    if (rel === '') return { allowed: true };
    const probe = isDirectory ? `${rel}/` : rel;

    if (rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/') || rel.endsWith('/.git')) {
      return { allowed: false, reason: 'vcs' };
    }
    if (this.sensitive.ignores(probe)) return { allowed: false, reason: 'sensitive' };
    if (this.defaults.ignores(probe)) return { allowed: false, reason: 'default' };
    if (this.user.ignores(probe)) return { allowed: false, reason: 'excluded' };
    if (this.useGitignore && this.ignoredByGit(rel, isDirectory)) return { allowed: false, reason: 'gitignore' };
    return { allowed: true };
  }

  isSensitive(relative: string): boolean {
    return this.sensitive.ignores(relative.replace(/^\.\//, ''));
  }

  /** Forget cached .gitignore files, for example after one was edited. */
  reset(): void {
    this.gitignores.clear();
  }

  private ignoredByGit(rel: string, isDirectory: boolean): boolean {
    const segments = rel.split('/');
    // Walk from the root down. A deeper .gitignore may re-include a file
    // that a higher one ignored, as git does.
    let ignored = false;
    for (let depth = 0; depth < segments.length; depth++) {
      const rules = this.loadGitignore(segments.slice(0, depth).join('/'));
      if (!rules) continue;
      const sub = segments.slice(depth).join('/');
      const result = rules.test(isDirectory ? `${sub}/` : sub);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  private loadGitignore(dir: string): Ignore | undefined {
    if (this.gitignores.has(dir)) return this.gitignores.get(dir);
    let rules: Ignore | undefined;
    const file = path.join(this.root, ...dir.split('/').filter(Boolean), '.gitignore');
    try {
      if (existsSync(file)) rules = ignore().add(readFileSync(file, 'utf8'));
    } catch {
      rules = undefined;
    }
    this.gitignores.set(dir, rules);
    return rules;
  }
}

export function describeBlock(reason: BlockReason | undefined): string {
  switch (reason) {
    case 'sensitive':
      return 'sensitive file';
    case 'gitignore':
      return 'ignored by .gitignore';
    case 'excluded':
      return 'excluded in settings';
    case 'vcs':
      return 'version control data';
    case 'default':
      return 'dependency or cache folder';
    default:
      return 'not available';
  }
}
