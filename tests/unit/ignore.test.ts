import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathPolicy } from '../../src/context/ignore';
import { resolveInWorkspace } from '../../src/context/paths';
import { ByteAgentError } from '../../src/shared/errors';
import { tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace | undefined;
afterEach(() => {
  ws?.dispose();
  ws = undefined;
});

describe('PathPolicy', () => {
  it('blocks sensitive files regardless of .gitignore', () => {
    ws = tempWorkspace({});
    const policy = new PathPolicy(ws.root);
    for (const p of ['.env', '.env.local', 'config/.env.production', 'certs/server.pem', 'keys/private.key', 'id_rsa', 'home/.ssh/config', '.npmrc', 'app/secrets.yaml', 'credentials.json', 'infra/prod.tfvars', 'x/terraform.tfstate', 'store.p12', '.aws/credentials']) {
      expect(policy.check(p), p).toEqual({ allowed: false, reason: 'sensitive' });
      expect(policy.isSensitive(p), p).toBe(true);
    }
  });

  it('allows example env files and ordinary source files', () => {
    ws = tempWorkspace({});
    const policy = new PathPolicy(ws.root);
    for (const p of ['.env.example', '.env.sample', 'src/app.ts', 'src/keyboard.ts', 'docs/secrets-management.md', 'src/environment.ts', 'README.md']) {
      expect(policy.check(p), p).toEqual({ allowed: true });
    }
  });

  it('blocks version control data and dependency folders by default', () => {
    ws = tempWorkspace({});
    const policy = new PathPolicy(ws.root);
    expect(policy.check('.git', true).reason).toBe('vcs');
    expect(policy.check('.git/config').reason).toBe('vcs');
    expect(policy.check('packages/a/.git/HEAD').reason).toBe('vcs');
    expect(policy.check('node_modules', true).reason).toBe('default');
    expect(policy.check('node_modules/x/index.js').reason).toBe('default');
    expect(policy.check('packages/a/node_modules/x.js').reason).toBe('default');
    expect(policy.check('.gitignore').allowed).toBe(true);
    expect(policy.check('.github/workflows/ci.yml').allowed).toBe(true);
  });

  it('applies root and nested .gitignore files, including negation', () => {
    ws = tempWorkspace({
      '.gitignore': 'dist/\n*.log\n/only-root.txt\n',
      'packages/api/.gitignore': 'generated/\n!keep.log\n',
    });
    const policy = new PathPolicy(ws.root);
    expect(policy.check('dist', true).reason).toBe('gitignore');
    expect(policy.check('dist/app.js').reason).toBe('gitignore');
    expect(policy.check('a/b/debug.log').reason).toBe('gitignore');
    expect(policy.check('only-root.txt').reason).toBe('gitignore');
    expect(policy.check('sub/only-root.txt').allowed).toBe(true);
    expect(policy.check('packages/api/generated/x.ts').reason).toBe('gitignore');
    expect(policy.check('packages/web/generated/x.ts').allowed).toBe(true);
    expect(policy.check('packages/api/keep.log').allowed).toBe(true);
    expect(policy.check('packages/api/other.log').reason).toBe('gitignore');
  });

  it('applies user exclusions from settings', () => {
    ws = tempWorkspace({});
    const policy = new PathPolicy(ws.root, { exclude: ['internal/**', '*.sql', '  '] });
    expect(policy.check('internal/notes.md').reason).toBe('excluded');
    expect(policy.check('db/schema.sql').reason).toBe('excluded');
    expect(policy.check('src/a.ts').allowed).toBe(true);
  });

  it('picks up an edited .gitignore after reset', () => {
    ws = tempWorkspace({ '.gitignore': 'a.txt\n' });
    const policy = new PathPolicy(ws.root);
    expect(policy.check('b.txt').allowed).toBe(true);
    ws.write('.gitignore', 'b.txt\n');
    expect(policy.check('b.txt').allowed).toBe(true);
    policy.reset();
    expect(policy.check('b.txt').reason).toBe('gitignore');
    expect(policy.check('a.txt').allowed).toBe(true);
  });
});

describe('resolveInWorkspace', () => {
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      return err instanceof ByteAgentError ? err.code : 'other';
    }
    return 'none';
  };

  it('normalises paths inside the workspace', () => {
    ws = tempWorkspace({ 'src/a.ts': 'x' });
    expect(resolveInWorkspace(ws.root, 'src/a.ts')).toBe('src/a.ts');
    expect(resolveInWorkspace(ws.root, './src/../src/a.ts')).toBe('src/a.ts');
    expect(resolveInWorkspace(ws.root, 'src\\a.ts')).toBe('src/a.ts');
    expect(resolveInWorkspace(ws.root, join(ws.root, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(resolveInWorkspace(ws.root, 'new/folder/file.ts')).toBe('new/folder/file.ts');
  });

  it('rejects paths that leave the workspace', () => {
    ws = tempWorkspace({ 'src/a.ts': 'x' });
    const root = ws.root;
    expect(code(() => resolveInWorkspace(root, '../outside.txt'))).toBe('path_outside_workspace');
    expect(code(() => resolveInWorkspace(root, 'src/../../outside.txt'))).toBe('path_outside_workspace');
    expect(code(() => resolveInWorkspace(root, '/etc/passwd'))).toBe('path_outside_workspace');
    expect(code(() => resolveInWorkspace(root, '..\\..\\windows\\system32'))).toBe('path_outside_workspace');
  });

  it('rejects empty, root and malformed paths', () => {
    ws = tempWorkspace({});
    const root = ws.root;
    expect(code(() => resolveInWorkspace(root, ''))).toBe('invalid_arguments');
    expect(code(() => resolveInWorkspace(root, '   '))).toBe('invalid_arguments');
    expect(code(() => resolveInWorkspace(root, '.'))).toBe('invalid_arguments');
    expect(code(() => resolveInWorkspace(root, 'a\0b'))).toBe('invalid_arguments');
    expect(code(() => resolveInWorkspace(root, 42 as unknown as string))).toBe('invalid_arguments');
  });

  it('rejects symlinks that point outside the workspace', () => {
    ws = tempWorkspace({ 'src/a.ts': 'x' });
    const outside = tempWorkspace({ 'secret.txt': 'outside' });
    try {
      symlinkSync(outside.root, join(ws.root, 'link'));
      symlinkSync(join(outside.root, 'secret.txt'), join(ws.root, 'src', 'alias.txt'));
      const root = ws.root;
      expect(code(() => resolveInWorkspace(root, 'link/secret.txt'))).toBe('path_outside_workspace');
      expect(code(() => resolveInWorkspace(root, 'link/new-file.txt'))).toBe('path_outside_workspace');
      expect(code(() => resolveInWorkspace(root, 'src/alias.txt'))).toBe('path_outside_workspace');
    } finally {
      outside.dispose();
    }
  });
});
