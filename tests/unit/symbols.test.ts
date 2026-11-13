import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSymbols, normalizeName, SymbolIndex } from '../../src/context/symbols';
import { tempWorkspace, type TempWorkspace } from '../helpers/tempWorkspace';

let ws: TempWorkspace | undefined;
afterEach(() => {
  ws?.dispose();
  ws = undefined;
});

const names = (text: string, ext: string): Array<[string, string, number]> => extractSymbols(text, ext).map((s) => [s.name, s.kind, s.line]);

describe('extractSymbols', () => {
  it('finds TypeScript and JavaScript declarations', () => {
    const text = [
      'import { x } from "./x";',
      'export async function loadOrders(id: string) {}',
      'function* walk() {}',
      'export default class OrderService {',
      '  private async fetchAll(limit: number): Promise<Order[]> {',
      '    if (limit) { return []; }',
      '  }',
      '}',
      'export interface Order { id: string }',
      'export type OrderId = string;',
      'export enum Status { Open }',
      'export const formatPrice = (value: number) => value.toFixed(2);',
      'const helper = async (a) => a;',
      'export const MAX_ITEMS = 50;',
      'const RETRY_LIMIT = 3;',
      'const local = 1;',
    ].join('\n');
    expect(names(text, 'ts')).toEqual([
      ['loadOrders', 'function', 2],
      ['walk', 'function', 3],
      ['OrderService', 'class', 4],
      ['fetchAll', 'method', 5],
      ['Order', 'interface', 9],
      ['OrderId', 'type', 10],
      ['Status', 'enum', 11],
      ['formatPrice', 'function', 12],
      ['helper', 'function', 13],
      ['MAX_ITEMS', 'constant', 14],
      ['RETRY_LIMIT', 'constant', 15],
    ]);
  });

  it('finds Python, Go and Rust declarations', () => {
    expect(names('import os\nMAX_SIZE = 10\nclass UserRepo:\n    def find_by_email(self, email):\n        pass\nasync def send_mail(to):\n    pass\n', 'py')).toEqual([
      ['MAX_SIZE', 'constant', 2],
      ['UserRepo', 'class', 3],
      ['find_by_email', 'method', 4],
      ['send_mail', 'function', 6],
    ]);
    expect(names('package x\nfunc NewServer(port int) *Server {}\nfunc (s *Server) Start() error {}\ntype Server struct {}\ntype Handler interface {}\nconst DefaultPort = 80\n', 'go')).toEqual([
      ['NewServer', 'function', 2],
      ['Start', 'function', 3],
      ['Server', 'struct', 4],
      ['Handler', 'interface', 5],
      ['DefaultPort', 'constant', 6],
    ]);
    expect(names('pub fn parse_config(path: &str) {}\npub struct Config {}\nenum Mode { A }\npub trait Loader {}\nconst MAX_DEPTH: u8 = 3;\n', 'rs')).toEqual([
      ['parse_config', 'function', 1],
      ['Config', 'struct', 2],
      ['Mode', 'enum', 3],
      ['Loader', 'trait', 4],
      ['MAX_DEPTH', 'constant', 5],
    ]);
  });

  it('finds Java-style, Ruby and PHP declarations', () => {
    expect(names('public class InvoiceService {\n    public Invoice createInvoice(Order order) {\n    }\n}\ninterface Billing {}\n', 'java').map((n) => n[0])).toEqual(['InvoiceService', 'createInvoice', 'Billing']);
    expect(names('module Billing\n  class Invoice\n    def total_due\n    end\n    def self.build(x)\n    end\n  end\nend\n', 'rb').map((n) => n[0])).toEqual(['Billing', 'Invoice', 'total_due', 'build']);
    expect(names('<?php\nclass Cart {\n    public function addItem($item) {}\n}\nfunction helper() {}\n', 'php').map((n) => n[0])).toEqual(['Cart', 'addItem', 'helper']);
  });

  it('ignores control flow, unsupported files and absurdly long lines', () => {
    expect(names('  if (x) {\n  for (const a of b) {\n  while (true) {\n  switch (v) {\n  return foo(bar);\n', 'ts')).toEqual([]);
    expect(names('function real() {}', 'md')).toEqual([]);
    expect(names(`export function minified(){${'x'.repeat(500)}}`, 'js')).toEqual([]);
    expect(names('', 'ts')).toEqual([]);
  });

  it('normalises names written in any style', () => {
    expect(normalizeName('getUserProfile')).toBe('getuserprofile');
    expect(normalizeName('get_user_profile')).toBe('getuserprofile');
    expect(normalizeName('Get User-Profile')).toBe('getuserprofile');
  });
});

describe('SymbolIndex', () => {
  it('indexes declarations and finds them by name, style-insensitively', async () => {
    ws = tempWorkspace({
      'src/pricing.ts': 'export function orderTotal() {}\nexport const TAX_RATE = 0.2;\n',
      'src/users.py': 'def get_user_profile(id):\n    pass\n',
      'README.md': 'function notCode() {}\n',
      '.env': 'function secret() {}\n',
    });
    const symbols = new SymbolIndex(ws.index());
    const stats = await symbols.update();
    expect(stats).toMatchObject({ files: 2, symbols: 3, reparsed: 2 });
    expect(symbols.find('orderTotal')).toEqual([{ name: 'orderTotal', kind: 'function', line: 1, path: 'src/pricing.ts' }]);
    expect(symbols.find('order_total')[0]?.path).toBe('src/pricing.ts');
    expect(symbols.find('getUserProfile')[0]?.path).toBe('src/users.py');
    expect(symbols.findContaining('userprofile')[0]?.name).toBe('get_user_profile');
    expect(symbols.findContaining('user')).toEqual([]);
    expect(symbols.find('secret')).toEqual([]);
    expect(symbols.find('notCode')).toEqual([]);
  });

  it('re-reads only files that changed, and forgets deleted files', async () => {
    ws = tempWorkspace({ 'a.ts': 'export function alpha() {}\n', 'b.ts': 'export function beta() {}\n', 'c.ts': 'export function gamma() {}\n' });
    const index = ws.index();
    const symbols = new SymbolIndex(index);
    expect((await symbols.update()).reparsed).toBe(3);
    expect((await symbols.update()).reparsed).toBe(0);

    ws.write('b.ts', 'export function betaRenamed() {}\n');
    const future = new Date(Date.now() + 4000);
    utimesSync(join(ws.root, 'b.ts'), future, future);
    ws.remove('c.ts');
    ws.write('d.ts', 'export class Delta {}\n');
    index.markDirty();
    const stats = await symbols.update();
    expect(stats.reparsed).toBe(2);
    expect(symbols.find('beta')).toEqual([]);
    expect(symbols.find('betaRenamed')[0]?.path).toBe('b.ts');
    expect(symbols.find('gamma')).toEqual([]);
    expect(symbols.find('Delta')[0]?.kind).toBe('class');
    expect(symbols.find('alpha')[0]?.path).toBe('a.ts');
    expect(symbols.entries().map((e) => e.path).sort()).toEqual(['a.ts', 'b.ts', 'd.ts']);
  });
});
