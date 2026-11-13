import { describe, expect, it } from 'vitest';
import {
  findActiveProfile,
  makeProfileId,
  normalizeBaseUrl,
  parseSettings,
  validateProfile,
} from '../../src/config/settings';

const good = { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'm-1' };

describe('normalizeBaseUrl', () => {
  it('removes trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1');
  });
  it('removes a pasted endpoint suffix', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('https://api.example.com/v1/models')).toBe('https://api.example.com/v1');
  });
  it('adds https for remote hosts and http for local hosts when the scheme is missing', () => {
    expect(normalizeBaseUrl('api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('localhost:11434/v1')).toBe('http://localhost:11434/v1');
  });
  it('drops query strings and fragments', () => {
    expect(normalizeBaseUrl('https://x.test/v1?key=abc#frag')).toBe('https://x.test/v1');
  });
  it('rejects other schemes, empty input and embedded credentials', () => {
    expect(() => normalizeBaseUrl('ftp://x.test')).toThrow(/http/);
    expect(() => normalizeBaseUrl('   ')).toThrow();
    expect(() => normalizeBaseUrl('https://user:pass@x.test/v1')).toThrow(/credentials/i);
    expect(() => normalizeBaseUrl('https://')).toThrow();
  });
  it('keeps a bare host without a path', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com');
  });
});

describe('validateProfile', () => {
  it('accepts a minimal valid profile', () => {
    const r = validateProfile(good);
    expect(r.ok).toBe(true);
    expect(r.profile).toEqual(good);
    expect(r.warnings).toEqual([]);
  });
  it('reports every missing required field', () => {
    const r = validateProfile({});
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.field).sort()).toEqual(['baseUrl', 'id', 'model', 'name']);
  });
  it('rejects non-objects', () => {
    expect(validateProfile(null).ok).toBe(false);
    expect(validateProfile('x').ok).toBe(false);
    expect(validateProfile([]).ok).toBe(false);
  });
  it('warns about plain http to a remote host but not to localhost', () => {
    expect(validateProfile({ ...good, baseUrl: 'http://example.com/v1' }).warnings).toHaveLength(1);
    expect(validateProfile({ ...good, baseUrl: 'http://localhost:1234/v1' }).warnings).toHaveLength(0);
    expect(validateProfile({ ...good, baseUrl: 'http://127.0.0.1:1234/v1' }).warnings).toHaveLength(0);
  });
  it('validates numeric ranges', () => {
    expect(validateProfile({ ...good, temperature: 3 }).ok).toBe(false);
    expect(validateProfile({ ...good, temperature: -0.1 }).ok).toBe(false);
    expect(validateProfile({ ...good, temperature: 0.7 }).profile?.temperature).toBe(0.7);
    expect(validateProfile({ ...good, maxOutputTokens: 1.5 }).ok).toBe(false);
    expect(validateProfile({ ...good, timeoutSeconds: 2 }).ok).toBe(false);
    expect(validateProfile({ ...good, timeoutSeconds: 90 }).profile?.timeoutSeconds).toBe(90);
    expect(validateProfile({ ...good, contextWindow: 10 }).ok).toBe(false);
  });
  it('accepts numbers typed as strings and treats empty strings as unset', () => {
    const r = validateProfile({ ...good, temperature: '0.2', maxOutputTokens: '', contextWindow: '8000' });
    expect(r.ok).toBe(true);
    expect(r.profile?.temperature).toBe(0.2);
    expect(r.profile?.maxOutputTokens).toBeUndefined();
    expect(r.profile?.contextWindow).toBe(8000);
  });
  it('rejects non-numeric strings', () => {
    expect(validateProfile({ ...good, temperature: 'hot' }).ok).toBe(false);
  });
  it('requires output tokens below the context window', () => {
    expect(validateProfile({ ...good, contextWindow: 4000, maxOutputTokens: 4000 }).ok).toBe(false);
    expect(validateProfile({ ...good, contextWindow: 4000, maxOutputTokens: 1000 }).ok).toBe(true);
  });
  it('rejects unknown tool calling modes and bad ids', () => {
    expect(validateProfile({ ...good, toolCalling: 'magic' }).ok).toBe(false);
    expect(validateProfile({ ...good, toolCalling: 'text' }).profile?.toolCalling).toBe('text');
    expect(validateProfile({ ...good, id: 'has space' }).ok).toBe(false);
  });
  it('rejects model names with line breaks', () => {
    expect(validateProfile({ ...good, model: 'a\nb' }).ok).toBe(false);
  });
  it('does not copy unknown fields such as an api key into the profile', () => {
    const r = validateProfile({ ...good, apiKey: 'sk-should-not-be-here' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.profile)).not.toContain('sk-should-not-be-here');
  });
});

describe('parseSettings', () => {
  it('returns defaults for empty configuration', () => {
    const { settings, problems } = parseSettings({});
    expect(problems).toEqual([]);
    expect(settings.providers).toEqual([]);
    expect(settings.activeProvider).toBe('');
    expect(settings.defaultMode).toBe('auto');
    expect(settings.maxFileSizeKb).toBe(512);
    expect(settings.confirmBeforeSend).toBe(false);
  });
  it('keeps valid profiles and reports invalid ones without throwing', () => {
    const { settings, problems } = parseSettings({ providers: [good, { id: 'bad' }, 7] });
    expect(settings.providers).toHaveLength(1);
    expect(problems).toHaveLength(2);
    expect(problems[0]?.setting).toBe('byteagent.providers[1]');
  });
  it('reports duplicate ids', () => {
    const { settings, problems } = parseSettings({ providers: [good, { ...good, name: 'Other' }] });
    expect(settings.providers).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/Duplicate/);
  });
  it('falls back to the first profile when the active id is unknown', () => {
    const { settings, problems } = parseSettings({ providers: [good], activeProvider: 'missing' });
    expect(settings.activeProvider).toBe('openai');
    expect(problems).toHaveLength(1);
    expect(findActiveProfile(settings)?.id).toBe('openai');
  });
  it('reports a providers value that is not a list', () => {
    const { settings, problems } = parseSettings({ providers: 'nope' });
    expect(settings.providers).toEqual([]);
    expect(problems).toHaveLength(1);
  });
  it('clamps numbers and ignores wrong types', () => {
    const { settings } = parseSettings({
      'context.maxFileSizeKb': 999999,
      'commands.timeoutSeconds': 'x',
      'agent.defaultMode': 'turbo',
      'context.exclude': ['a/**', 3, ''],
      logLevel: 'loud',
    });
    expect(settings.maxFileSizeKb).toBe(10240);
    expect(settings.commandTimeoutSeconds).toBe(120);
    expect(settings.defaultMode).toBe('auto');
    expect(settings.exclude).toEqual(['a/**']);
    expect(settings.logLevel).toBe('info');
  });
});

describe('makeProfileId', () => {
  it('slugifies names and avoids collisions', () => {
    expect(makeProfileId('My Provider!', [])).toBe('my-provider');
    expect(makeProfileId('My Provider', ['my-provider'])).toBe('my-provider-2');
    expect(makeProfileId('***', [])).toBe('provider');
  });
});
