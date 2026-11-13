// Screenshots UI harness scenarios with headless Chrome.
// Usage: node scripts/shot.mjs <outDir> name:"hash params":WxH [more…]
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'harness');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path === '/' ? 'harness.html' : path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || specs.length === 0) {
  console.error('usage: node scripts/shot.mjs <outDir> name:"hash":WxH …');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const chrome = process.env.CHROME ?? 'google-chrome';

for (const spec of specs) {
  const [name, hash = '', size = '420x900'] = spec.split('::');
  const [w, h] = size.split('x');
  const out = join(outDir, `${name}.png`);
  await new Promise((resolve) => {
    execFile(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ba-shot-'))}`,
        '--virtual-time-budget=6000',
        `--window-size=${w},${h}`,
        `--screenshot=${out}`,
        `http://127.0.0.1:${port}/harness.html#width=${w}&${hash}`,
      ],
      { timeout: 60000 },
      () => resolve(undefined),
    );
  });
  console.log(out);
}
server.close();
