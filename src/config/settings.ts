/**
 * Settings model and validation. Pure logic: no VS Code imports, so it can
 * be unit tested and reused by the webview protocol.
 */

import type { LogLevel } from '../shared/logger';
import type { FieldProblem, ModeSetting, ToolCallingMode } from '../shared/protocol';

export type { FieldProblem, ModeSetting, ToolCallingMode };

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  timeoutSeconds?: number;
  toolCalling?: ToolCallingMode;
}

export interface ByteAgentSettings {
  providers: ProviderProfile[];
  activeProvider: string;
  defaultMode: ModeSetting;
  exclude: string[];
  maxFileSizeKb: number;
  defaultContextWindow: number;
  confirmBeforeSend: boolean;
  commandTimeoutSeconds: number;
  logLevel: LogLevel;
}

export interface ProfileValidation {
  ok: boolean;
  profile?: ProviderProfile;
  errors: FieldProblem[];
  warnings: FieldProblem[];
}

export const DEFAULT_SETTINGS: ByteAgentSettings = {
  providers: [],
  activeProvider: '',
  defaultMode: 'auto',
  exclude: [],
  maxFileSizeKb: 512,
  defaultContextWindow: 32000,
  confirmBeforeSend: false,
  commandTimeoutSeconds: 120,
  logLevel: 'info',
};

export const DEFAULT_TIMEOUT_SECONDS = 60;

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  /** Shown as placeholder text only; never sent anywhere. */
  modelHint: string;
  keyHelpUrl?: string;
}

/** Starting points for the setup screen. Every one is OpenAI-compatible. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    modelHint: 'Model name from your OpenAI account',
    keyHelpUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    modelHint: 'vendor/model-name',
    keyHelpUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    modelHint: 'Model name from your Groq console',
    keyHelpUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    modelHint: 'Model name from your DeepSeek account',
    keyHelpUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    modelHint: 'A model you have pulled locally',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    modelHint: 'The model loaded in LM Studio',
  },
  {
    id: 'custom',
    name: 'Custom endpoint',
    baseUrl: '',
    needsKey: true,
    modelHint: 'Model name',
  },
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || h.endsWith('.local');
}

/**
 * Cleans a base URL typed or pasted by a user. Returns the normalised URL
 * or throws with a message that explains what is wrong.
 */
export function normalizeBaseUrl(input: string): string {
  let text = (input ?? '').trim();
  if (!text) throw new Error('Enter the base URL of your provider.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // "localhost:11434/v1" or "api.example.com/v1" without a scheme.
    const host = text.split('/')[0]?.split(':')[0] ?? '';
    text = `${isLocalHost(host) ? 'http' : 'https'}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The base URL must start with http:// or https://');
  }
  if (url.username || url.password) {
    throw new Error('Do not put credentials in the URL. Use the API key field instead.');
  }
  url.hash = '';
  url.search = '';
  let path = url.pathname.replace(/\/+$/, '');
  // People often paste the full endpoint.
  path = path.replace(/\/(chat\/completions|completions|models|embeddings)$/i, '');
  url.pathname = path || '/';
  return url.toString().replace(/\/+$/, '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(
  raw: Record<string, unknown>,
  field: string,
  errors: FieldProblem[],
  rule: { min: number; max: number; integer?: boolean },
): number | undefined {
  const value = raw[field];
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    errors.push({ field, message: 'Must be a number.' });
    return undefined;
  }
  if (rule.integer && !Number.isInteger(num)) {
    errors.push({ field, message: 'Must be a whole number.' });
    return undefined;
  }
  if (num < rule.min || num > rule.max) {
    errors.push({ field, message: `Must be between ${rule.min} and ${rule.max}.` });
    return undefined;
  }
  return num;
}

export function validateProfile(raw: unknown): ProfileValidation {
  const errors: FieldProblem[] = [];
  const warnings: FieldProblem[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ field: 'profile', message: 'Profile must be an object.' }], warnings };
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) errors.push({ field: 'id', message: 'Missing profile id.' });
  else if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    errors.push({ field: 'id', message: 'Id may contain letters, digits, dot, dash and underscore only.' });
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) errors.push({ field: 'name', message: 'Give this provider a name.' });
  else if (name.length > 60) errors.push({ field: 'name', message: 'Name is too long (60 characters max).' });

  let baseUrl = '';
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) {
    errors.push({ field: 'baseUrl', message: 'Enter the base URL of your provider.' });
  } else {
    try {
      baseUrl = normalizeBaseUrl(raw.baseUrl);
      const url = new URL(baseUrl);
      if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
        warnings.push({
          field: 'baseUrl',
          message: 'This URL uses plain http. Your API key and code would travel unencrypted.',
        });
      }
    } catch (err) {
      errors.push({ field: 'baseUrl', message: (err as Error).message });
    }
  }

  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) errors.push({ field: 'model', message: 'Enter a model name.' });
  else if (model.length > 200 || /[\r\n]/.test(model)) {
    errors.push({ field: 'model', message: 'That model name is not valid.' });
  }

  const temperature = optionalNumber(raw, 'temperature', errors, { min: 0, max: 2 });
  const maxOutputTokens = optionalNumber(raw, 'maxOutputTokens', errors, {
    min: 1,
    max: 1_000_000,
    integer: true,
  });
  const contextWindow = optionalNumber(raw, 'contextWindow', errors, {
    min: 1000,
    max: 10_000_000,
    integer: true,
  });
  const timeoutSeconds = optionalNumber(raw, 'timeoutSeconds', errors, { min: 5, max: 600, integer: true });

  let toolCalling: ToolCallingMode | undefined;
  if (raw.toolCalling !== undefined && raw.toolCalling !== null && raw.toolCalling !== '') {
    if (raw.toolCalling === 'auto' || raw.toolCalling === 'native' || raw.toolCalling === 'text') {
      toolCalling = raw.toolCalling;
    } else {
      errors.push({ field: 'toolCalling', message: 'Must be auto, native or text.' });
    }
  }

  if (contextWindow !== undefined && maxOutputTokens !== undefined && maxOutputTokens >= contextWindow) {
    errors.push({ field: 'maxOutputTokens', message: 'Must be smaller than the context window.' });
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const profile: ProviderProfile = { id, name, baseUrl, model };
  if (temperature !== undefined) profile.temperature = temperature;
  if (maxOutputTokens !== undefined) profile.maxOutputTokens = maxOutputTokens;
  if (contextWindow !== undefined) profile.contextWindow = contextWindow;
  if (timeoutSeconds !== undefined) profile.timeoutSeconds = timeoutSeconds;
  if (toolCalling !== undefined) profile.toolCalling = toolCalling;
  return { ok: true, profile, errors, warnings };
}

export interface SettingsProblem {
  setting: string;
  message: string;
}

export interface ParsedSettings {
  settings: ByteAgentSettings;
  problems: SettingsProblem[];
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Turns raw configuration values into safe settings. Invalid values fall
 * back to defaults and are reported, so a bad setting never crashes the
 * extension.
 */
export function parseSettings(raw: Record<string, unknown>): ParsedSettings {
  const problems: SettingsProblem[] = [];
  const providers: ProviderProfile[] = [];
  const seen = new Set<string>();

  const rawProviders = raw['providers'];
  if (rawProviders !== undefined && !Array.isArray(rawProviders)) {
    problems.push({ setting: 'byteagent.providers', message: 'Must be a list of provider profiles.' });
  }
  if (Array.isArray(rawProviders)) {
    rawProviders.forEach((entry, index) => {
      const result = validateProfile(entry);
      if (!result.ok || !result.profile) {
        const detail = result.errors.map((e) => `${e.field}: ${e.message}`).join(' ');
        problems.push({ setting: `byteagent.providers[${index}]`, message: detail });
        return;
      }
      if (seen.has(result.profile.id)) {
        problems.push({
          setting: `byteagent.providers[${index}]`,
          message: `Duplicate profile id "${result.profile.id}".`,
        });
        return;
      }
      seen.add(result.profile.id);
      providers.push(result.profile);
    });
  }

  let activeProvider = typeof raw['activeProvider'] === 'string' ? raw['activeProvider'] : '';
  if (activeProvider && !seen.has(activeProvider)) {
    problems.push({
      setting: 'byteagent.activeProvider',
      message: `No provider profile has the id "${activeProvider}".`,
    });
    activeProvider = '';
  }
  if (!activeProvider && providers[0]) activeProvider = providers[0].id;

  const modeRaw = raw['agent.defaultMode'];
  const defaultMode: ModeSetting =
    modeRaw === 'quick' || modeRaw === 'standard' || modeRaw === 'project' || modeRaw === 'auto'
      ? modeRaw
      : DEFAULT_SETTINGS.defaultMode;

  const excludeRaw = raw['context.exclude'];
  const exclude = Array.isArray(excludeRaw)
    ? excludeRaw.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];

  const levelRaw = raw['logLevel'];
  const logLevel: LogLevel =
    levelRaw === 'error' || levelRaw === 'warn' || levelRaw === 'info' || levelRaw === 'debug'
      ? levelRaw
      : DEFAULT_SETTINGS.logLevel;

  return {
    settings: {
      providers,
      activeProvider,
      defaultMode,
      exclude,
      maxFileSizeKb: clampInt(raw['context.maxFileSizeKb'], DEFAULT_SETTINGS.maxFileSizeKb, 1, 10240),
      defaultContextWindow: clampInt(
        raw['context.defaultContextWindow'],
        DEFAULT_SETTINGS.defaultContextWindow,
        2000,
        10_000_000,
      ),
      confirmBeforeSend: raw['context.confirmBeforeSend'] === true,
      commandTimeoutSeconds: clampInt(
        raw['commands.timeoutSeconds'],
        DEFAULT_SETTINGS.commandTimeoutSeconds,
        5,
        3600,
      ),
      logLevel,
    },
    problems,
  };
}

export function findActiveProfile(settings: ByteAgentSettings): ProviderProfile | undefined {
  return settings.providers.find((p) => p.id === settings.activeProvider);
}

/** Makes a profile id from a display name, unique among existing ids. */
export function makeProfileId(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'provider';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}
