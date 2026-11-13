import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/shared/logger';
import { REDACTED, Redactor } from '../../src/shared/redact';

describe('Redactor', () => {
  it('removes registered secrets everywhere they appear', () => {
    const r = new Redactor();
    r.addSecret('my-super-secret-value');
    const out = r.redact('a my-super-secret-value b my-super-secret-value');
    expect(out).not.toContain('my-super-secret-value');
    expect(out.split(REDACTED)).toHaveLength(3);
  });
  it('ignores very short secrets so ordinary text survives', () => {
    const r = new Redactor();
    r.addSecret('abc');
    expect(r.redact('abc def')).toBe('abc def');
  });
  it('redacts Authorization headers and bearer tokens', () => {
    const r = new Redactor();
    expect(r.redact('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890');
    expect(r.redact('{"authorization":"Bearer zzzzyyyyxxxx1111"}')).not.toContain('zzzzyyyyxxxx1111');
    expect(r.redact('sent bearer QWERTYUIOP123456 ok')).not.toContain('QWERTYUIOP123456');
  });
  it('redacts common key shapes without registration', () => {
    const r = new Redactor();
    expect(r.redact('key sk-abcdefghijklmnopqrstuvwx end')).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(r.redact('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(REDACTED);
    expect(r.redact('AKIAABCDEFGHIJKLMNOP')).toBe(REDACTED);
  });
  it('redacts secret-looking assignments', () => {
    const r = new Redactor();
    expect(r.redact('API_KEY=hunter2hunter2')).not.toContain('hunter2hunter2');
    expect(r.redact('password: "s3cr3tvalue"')).not.toContain('s3cr3tvalue');
    expect(r.redact('x-api-key: abcd1234abcd')).not.toContain('abcd1234abcd');
    expect(r.redact('?token=abcdef123456&x=1')).not.toContain('abcdef123456');
  });
  it('redacts credentials in URLs and private keys', () => {
    const r = new Redactor();
    expect(r.redact('postgres://admin:p4ssw0rd@db.local/x')).not.toContain('p4ssw0rd');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(r.redact(`key:\n${pem}\nend`)).not.toContain('MIIabc');
  });
  it('leaves ordinary text alone', () => {
    const r = new Redactor();
    const text = 'function tokenize(input) { return input.split(" "); } // 200 OK';
    expect(r.redact(text)).toBe(text);
  });
  it('redacts nested values and secret-named keys', () => {
    const r = new Redactor();
    r.addSecret('topsecret-123');
    const out = r.redactValue({ a: ['x topsecret-123'], apiKey: 'whatever', n: 1, nested: { token: 'abc' } });
    expect(JSON.stringify(out)).not.toContain('topsecret-123');
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested.token).toBe(REDACTED);
    expect(out.n).toBe(1);
  });
});

describe('createLogger', () => {
  it('redacts every line and data payload', () => {
    const r = new Redactor();
    r.addSecret('live-key-0001');
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), r, 'debug');
    log.info('using live-key-0001');
    log.error('failed', { header: 'Authorization: Bearer live-key-0001' });
    log.debug('err', new Error('bad live-key-0001'));
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('live-key-0001');
  });
  it('respects the log level', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), new Redactor(), 'warn');
    log.info('hidden');
    log.debug('hidden');
    log.warn('shown');
    log.error('shown');
    expect(lines).toHaveLength(2);
    log.setLevel('debug');
    log.debug('now shown');
    expect(lines).toHaveLength(3);
  });
  it('survives unserialisable data', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), new Redactor(), 'info');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.info('x', circular);
    expect(lines[0]).toContain('[unserialisable]');
  });
});
