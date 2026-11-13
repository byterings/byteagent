/**
 * Measurements for the Milestone 8 items. They print their numbers so the
 * result can be recorded, and fail only if an enhancement makes things worse.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rankFiles } from '../../src/context/ranker';
import { SymbolIndex } from '../../src/context/symbols';
import { tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

const workspaces: TempWorkspace[] = [];
afterAll(() => workspaces.forEach((w) => w.dispose()));

/** A project where related words appear in many files, as they do in real code. */
function evalProject(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': '{"name":"shop","scripts":{"test":"vitest run"}}',
    'src/orders/orderTotal.ts': "import { applyCoupon } from '../pricing/coupons';\nexport function calculateOrderTotal(order: Order): number {\n  return applyCoupon(order.lines.reduce((s, l) => s + l.price, 0), order.coupon);\n}\n",
    'src/orders/orderRepository.ts': 'export class OrderRepository {\n  async findOrderById(id: string) { return null; }\n  async saveOrder(order: Order) {}\n}\n',
    'src/orders/routes.ts': "import { calculateOrderTotal } from './orderTotal';\nexport function registerOrderRoutes(app: App) {\n  app.get('/orders/:id/total', (req) => calculateOrderTotal(req.order));\n}\n",
    'src/pricing/coupons.ts': 'export function applyCoupon(amount: number, coupon?: Coupon): number {\n  return coupon ? amount * (1 - coupon.rate) : amount;\n}\nexport function validateCouponCode(code: string): boolean { return code.length === 8; }\n',
    'src/pricing/tax.ts': 'export const DEFAULT_TAX_RATE = 0.2;\nexport function computeSalesTax(amount: number): number { return amount * DEFAULT_TAX_RATE; }\n',
    'src/users/profile.ts': 'export async function getUserProfile(userId: string) { return { userId }; }\nexport async function updateUserProfile(userId: string, patch: object) {}\n',
    'src/users/passwordReset.ts': 'export async function sendPasswordResetEmail(email: string) {}\nexport function verifyResetToken(token: string): boolean { return true; }\n',
    'src/users/session.ts': 'export class SessionManager {\n  createSession(userId: string) {}\n  revokeSession(sessionId: string) {}\n}\n',
    'src/shipping/rates.ts': 'export function estimateShippingCost(weightKg: number, country: string): number { return weightKg * 2; }\n',
    'src/shipping/tracking.ts': 'export async function fetchTrackingStatus(trackingNumber: string) { return "in transit"; }\n',
    'src/inventory/stock.ts': 'export function reserveStock(sku: string, qty: number) {}\nexport function releaseStock(sku: string, qty: number) {}\nexport function checkStockLevel(sku: string): number { return 0; }\n',
    'src/notifications/email.ts': 'export async function sendOrderConfirmation(order: Order) {}\nexport async function sendShippingUpdate(order: Order) {}\n',
    'src/payments/refunds.ts': 'export async function issueRefund(paymentId: string, amount: number) {}\n',
    'src/payments/charge.ts': 'export async function chargeCustomerCard(customerId: string, amount: number) {}\n',
    'src/config/featureFlags.ts': 'export function isFeatureEnabled(name: string): boolean { return false; }\n',
    'src/utils/retry.ts': 'export async function retryWithBackoff<T>(fn: () => Promise<T>, attempts = 3): Promise<T> { return fn(); }\n',
    'src/utils/dates.ts': 'export function formatInvoiceDate(d: Date): string { return d.toISOString(); }\n',
    'server/reports.py': 'def build_monthly_report(month):\n    pass\n\ndef export_report_csv(report):\n    pass\n',
    'server/cleanup.py': 'def purge_expired_sessions():\n    pass\n',
    'docs/overview.md': '# Overview\n\nOrders have a total, a coupon, tax and shipping cost. Users have a profile and can reset a password. Stock is reserved for orders. Refunds are issued for payments.\n',
  };
  // Noise: files that mention the same everyday words without defining anything relevant.
  const words = ['order', 'total', 'user', 'profile', 'password', 'reset', 'shipping', 'cost', 'stock', 'level', 'refund', 'coupon', 'tax', 'session', 'report', 'retry', 'invoice', 'date', 'feature', 'tracking', 'status'];
  for (let i = 0; i < 40; i++) {
    const a = words[i % words.length];
    const b = words[(i * 7 + 3) % words.length];
    files[`src/legacy/module${i}.ts`] = `// handles ${a} and ${b} edge cases for the old ${a} flow\nexport const legacyValue${i} = '${a} ${b}';\nexport function legacyHelper${i}() {\n  // ${b} ${a} ${b}\n  return '${a}';\n}\n`;
  }
  return files;
}

/** Requests phrased the way people talk, with the file that answers each. */
const QUERIES: Array<[string, string]> = [
  ['How is the order total calculated?', 'src/orders/orderTotal.ts'],
  ['Where do we apply a coupon?', 'src/pricing/coupons.ts'],
  ['Change how sales tax is computed', 'src/pricing/tax.ts'],
  ['Fix the bug in get user profile', 'src/users/profile.ts'],
  ['The password reset email is not sent', 'src/users/passwordReset.ts'],
  ['How do we estimate shipping cost?', 'src/shipping/rates.ts'],
  ['Where is the tracking status fetched?', 'src/shipping/tracking.ts'],
  ['Stock level check returns the wrong number', 'src/inventory/stock.ts'],
  ['Add logging when we issue a refund', 'src/payments/refunds.ts'],
  ['Why does charging the customer card fail?', 'src/payments/charge.ts'],
  ['Make retry with backoff wait longer', 'src/utils/retry.ts'],
  ['How is the invoice date formatted?', 'src/utils/dates.ts'],
  ['Who builds the monthly report?', 'server/reports.py'],
  ['Where do we purge expired sessions?', 'server/cleanup.py'],
  ['Is the feature enabled check cached?', 'src/config/featureFlags.ts'],
  ['Explain calculateOrderTotal', 'src/orders/orderTotal.ts'],
  ['What does SessionManager do?', 'src/users/session.ts'],
  ['Where is DEFAULT_TAX_RATE used?', 'src/pricing/tax.ts'],
];

interface Score {
  top1: number;
  top3: number;
  mrr: number;
  ms: number;
}

async function evaluate(useSymbols: boolean): Promise<Score> {
  const ws = tempWorkspace(evalProject());
  workspaces.push(ws);
  const index = ws.index();
  const symbols = useSymbols ? new SymbolIndex(index) : undefined;
  await index.refresh();
  await symbols?.update();
  let top1 = 0;
  let top3 = 0;
  let reciprocal = 0;
  const started = Date.now();
  for (const [prompt, expected] of QUERIES) {
    const ranked = await rankFiles(index, { prompt, attachments: [], contentSearch: true, symbols });
    const position = ranked.findIndex((r) => r.path === expected);
    if (position === 0) top1 += 1;
    if (position >= 0 && position < 3) top3 += 1;
    if (position >= 0) reciprocal += 1 / (position + 1);
  }
  return { top1, top3, mrr: reciprocal / QUERIES.length, ms: Date.now() - started };
}

describe('measurement: symbol-aware ranking', () => {
  it('finds the right file more often when declarations are indexed', async () => {
    const without = await evaluate(false);
    const withSymbols = await evaluate(true);
    const n = QUERIES.length;
    console.log(
      `[measure] retrieval on ${n} queries | without symbols: top-1 ${without.top1}/${n}, top-3 ${without.top3}/${n}, MRR ${without.mrr.toFixed(3)}, ${without.ms} ms` +
        ` | with symbols: top-1 ${withSymbols.top1}/${n}, top-3 ${withSymbols.top3}/${n}, MRR ${withSymbols.mrr.toFixed(3)}, ${withSymbols.ms} ms`,
    );
    expect(withSymbols.top1).toBeGreaterThanOrEqual(without.top1);
    expect(withSymbols.mrr).toBeGreaterThanOrEqual(without.mrr);
    expect(withSymbols.top3).toBeGreaterThanOrEqual(Math.ceil(n * 0.8));
  });
});

describe('measurement: incremental index updates', () => {
  it('updates one file far faster than rescanning everything', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3000; i++) files[`src/pkg${i % 60}/file${i}.ts`] = `export function fn${i}(a: number) {\n  return a + ${i};\n}\nexport const VALUE_${i} = ${i};\n`;
    const ws = tempWorkspace(files);
    workspaces.push(ws);
    const index = ws.index();
    const symbols = new SymbolIndex(index);

    let t = Date.now();
    await index.refresh();
    const firstScan = Date.now() - t;
    t = Date.now();
    const built = await symbols.update();
    const firstSymbols = Date.now() - t;

    // One file changes.
    ws.write('src/pkg1/file1.ts', 'export function renamedFunction() {}\n');

    t = Date.now();
    await index.refresh();
    const fullRescan = Date.now() - t;

    ws.write('src/pkg2/file2.ts', 'export function anotherRename() {}\n');
    t = Date.now();
    await index.refreshPath('src/pkg2/file2.ts');
    const incremental = Date.now() - t;

    t = Date.now();
    const updated = await symbols.update();
    const symbolUpdate = Date.now() - t;

    console.log(
      `[measure] 3000 files | first scan ${firstScan} ms | full rescan after one change ${fullRescan} ms | incremental update of one path ${incremental} ms` +
        ` | first symbol build ${firstSymbols} ms (${built.symbols} symbols) | symbol update after two changes ${symbolUpdate} ms (${updated.reparsed} files re-read)`,
    );
    expect(index.fileCount).toBe(3000);
    expect(symbols.find('anotherRename')[0]?.path).toBe('src/pkg2/file2.ts');
    expect(symbols.find('renamedFunction')[0]?.path).toBe('src/pkg1/file1.ts');
    expect(updated.reparsed).toBe(2);
    expect(incremental).toBeLessThan(Math.max(5, fullRescan / 5));
    expect(symbolUpdate).toBeLessThan(Math.max(20, firstSymbols / 3));
  }, 60000);
});
