// Installs the packaged .vsix into a clean VS Code profile and runs the
// extension tests against the installed copy (not the development folder).
const { runTests } = require('@vscode/test-electron');
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const vsix = path.join(root, 'byteagent.vsix');
  if (!existsSync(vsix)) throw new Error('byteagent.vsix not found. Run "npm run package" first.');

  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) if (key.startsWith('VSCODE_')) delete process.env[key];

  const scratch = mkdtempSync(path.join(tmpdir(), 'byteagent-vsix-'));
  const extensionsDir = path.join(scratch, 'extensions');
  const userDir = path.join(scratch, 'user');
  const workspace = path.join(scratch, 'workspace');
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  cpSync(path.join(root, 'tests', 'fixtures', 'workspace'), workspace, { recursive: true });

  const cli = ['/usr/bin/code', '/usr/local/bin/code'].find((p) => existsSync(p)) ?? 'code';
  const installed = execFileSync(cli, ['--install-extension', vsix, '--force', `--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDir}`], { encoding: 'utf8' });
  console.log(installed.trim());
  const listed = execFileSync(cli, ['--list-extensions', '--show-versions', `--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDir}`], { encoding: 'utf8' });
  console.log(`Installed: ${listed.trim()}`);
  if (!/byteagent\.byteagent@/.test(listed)) throw new Error('The extension is not listed after installation.');

  // The test host needs a development extension; this empty one adds nothing.
  const dummy = path.join(scratch, 'dummy');
  mkdirSync(dummy, { recursive: true });
  writeFileSync(path.join(dummy, 'package.json'), JSON.stringify({ name: 'dummy', publisher: 'test', version: '0.0.1', engines: { vscode: '^1.90.0' } }));

  const candidates = [process.env.VSCODE_TEST_EXECUTABLE, '/usr/share/code/code'];
  const code = await runTests({
    vscodeExecutablePath: candidates.find((p) => p && existsSync(p)),
    extensionDevelopmentPath: dummy,
    extensionTestsPath: path.join(root, 'dist', 'tests', 'index.js'),
    extensionTestsEnv: { BYTEAGENT_TEST: '1' },
    launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--password-store=basic', `--user-data-dir=${userDir}`, `--extensions-dir=${extensionsDir}`],
  });
  process.exit(code);
}

main().catch((err) => {
  console.error('VSIX test failed:', err && err.message ? err.message : err);
  process.exit(1);
});
