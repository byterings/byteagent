import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PathPolicy, type PathPolicyOptions } from '../../src/context/ignore';
import { WorkspaceIndex, type WorkspaceIndexOptions } from '../../src/context/workspaceIndex';

export interface TempWorkspace {
  root: string;
  write(relative: string, content: string | Uint8Array): void;
  remove(relative: string): void;
  dispose(): void;
  index(options?: WorkspaceIndexOptions & PathPolicyOptions): WorkspaceIndex;
}

/** Creates a real folder on disk with the given files. */
export function tempWorkspace(files: Record<string, string | Uint8Array> = {}): TempWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'byteagent-ws-'));
  const write = (relative: string, content: string | Uint8Array): void => {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  for (const [relative, content] of Object.entries(files)) write(relative, content);
  return {
    root,
    write,
    remove: (relative) => rmSync(join(root, relative), { recursive: true, force: true }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
    index: (options = {}) => new WorkspaceIndex(root, new PathPolicy(root, options), options),
  };
}

/** A small but realistic project used across context tests. */
export function sampleProject(): Record<string, string> {
  return {
    'package.json': JSON.stringify(
      { name: 'shop-api', scripts: { test: 'vitest run', build: 'tsc -p .', lint: 'eslint .' }, dependencies: { express: '^4.0.0' }, devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0' } },
      null,
      2,
    ),
    '.gitignore': 'node_modules/\ndist/\n*.log\n',
    '.env': 'DATABASE_URL=postgres://admin:hunter2@db/prod\nAPI_SECRET=topsecretvalue123\n',
    '.env.example': 'DATABASE_URL=\nAPI_SECRET=\n',
    'README.md': '# Shop API\n\nHandles orders, pricing and coupons.\n',
    'src/index.ts': "import { createApp } from './app';\ncreateApp().listen(3000);\n",
    'src/app.ts': "import express from 'express';\nimport { ordersRouter } from './routes/orders';\nexport function createApp() {\n  const app = express();\n  app.use('/orders', ordersRouter);\n  return app;\n}\n",
    'src/routes/orders.ts': "import { Router } from 'express';\nimport { orderTotal } from '../services/pricing';\nexport const ordersRouter = Router();\nordersRouter.post('/', (req, res) => {\n  res.json({ total: orderTotal(req.body) });\n});\n",
    'src/services/pricing.ts': [
      "import { TAX_RATE } from './tax';",
      '',
      'export interface Order { lines: Array<{ price: number; qty: number }>; couponRate: number }',
      '',
      'export function orderTotal(order: Order): number {',
      '  const subtotal = order.lines.reduce((sum, l) => sum + l.price * l.qty, 0);',
      '  const taxed = subtotal * (1 + TAX_RATE);',
      '  return roundCents(taxed * (1 - order.couponRate));',
      '}',
      '',
      'export function roundCents(value: number): number {',
      '  return Math.round(value * 100) / 100;',
      '}',
      '',
    ].join('\n'),
    'src/services/tax.ts': 'export const TAX_RATE = 0.2;\n',
    'src/services/email.ts': "export function sendReceipt(to: string): void {\n  console.log('sending receipt to', to);\n}\n",
    'src/utils/strings.ts': 'export function capitalize(s: string): string {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}\n',
    'tests/services/pricing.test.ts': "import { orderTotal } from '../../src/services/pricing';\nimport { expect, it } from 'vitest';\nit('totals an order', () => {\n  expect(orderTotal({ lines: [{ price: 10, qty: 2 }], couponRate: 0 })).toBe(24);\n});\n",
    'node_modules/express/index.js': 'module.exports = function orderTotal() {};\n',
    'dist/app.js': 'function orderTotal() {}\n',
    'debug.log': 'orderTotal called\n',
    'config/secrets.yaml': 'stripe: sk_live_abcdefghijklmnop\n',
    'certs/server.pem': '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n',
  };
}
