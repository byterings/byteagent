// Launches a real VS Code instance, loads the extension and runs the
// tests in dist/tests. Uses the installed VS Code when one is found.
const { runTests } = require('@vscode/test-electron');
const { existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const scratch = mkdtempSync(path.join(tmpdir(), 'byteagent-test-'));
  const workspace = path.join(scratch, 'workspace');
  cpSync(path.join(root, 'tests', 'fixtures', 'workspace'), workspace, { recursive: true });
  mkdirSync(path.join(scratch, 'user'), { recursive: true });

  // When this script runs from a VS Code terminal these variables would
  // make the test instance behave like a plain Node process.
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VSCODE_')) delete process.env[key];
  }

  const candidates = [process.env.VSCODE_TEST_EXECUTABLE, '/usr/share/code/code', '/usr/bin/code-insiders'];
  const vscodeExecutablePath = candidates.find((p) => p && existsSync(p));

  writeFileSync(path.join(scratch, 'workspace-path.txt'), workspace);

  const code = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist', 'tests', 'index.js'),
    extensionTestsEnv: { BYTEAGENT_TEST_WORKSPACE: workspace, BYTEAGENT_TEST: '1' },
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--password-store=basic',
      `--user-data-dir=${path.join(scratch, 'user')}`,
      `--extensions-dir=${path.join(scratch, 'extensions')}`,
    ],
  });
  process.exit(code);
}

main().catch((err) => {
  console.error('Extension tests failed to run:', err && err.message ? err.message : err);
  process.exit(1);
});
