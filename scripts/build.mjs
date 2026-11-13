// Bundles the extension host code (and, with --tests, the extension tests).
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

function copyWasm() {
  // sql.js loads its WebAssembly binary from disk at runtime.
  const wasm = require.resolve('sql.js/dist/sql-wasm.wasm');
  mkdirSync(join(root, 'dist'), { recursive: true });
  copyFileSync(wasm, join(root, 'dist', 'sql-wasm.wasm'));
}

async function main() {
  if (tests) {
    const dir = join(root, 'tests', 'extension');
    const entryPoints = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts') || f === 'index.ts')
      .map((f) => join(dir, f));
    await esbuild.build({
      ...common,
      entryPoints,
      outdir: join(root, 'dist', 'tests'),
      external: ['vscode', 'mocha'],
    });
    return;
  }

  copyWasm();
  const options = {
    ...common,
    entryPoints: [join(root, 'src', 'extension.ts')],
    outfile: join(root, 'dist', 'extension.js'),
  };
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('watching extension sources…');
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
