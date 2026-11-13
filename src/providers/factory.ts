import { OpenAICompatibleProvider } from './openaiCompatible';
import type { Provider } from './types';

/** The subset of a provider profile the factory needs. */
export interface ProviderConfig {
  id: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  timeoutSeconds?: number;
  toolCalling?: 'auto' | 'native' | 'text';
}

export interface ProviderFactoryOptions {
  apiKey?: string;
  redact?: (text: string) => string;
  defaultTimeoutSeconds?: number;
  fetchImpl?: typeof fetch;
  retryBaseDelayMs?: number;
}

/**
 * Builds a provider for a profile. Native adapters can be added here later
 * without changing any caller.
 */
export function createProvider(config: ProviderConfig, options: ProviderFactoryOptions = {}): Provider {
  const timeoutSeconds = config.timeoutSeconds ?? options.defaultTimeoutSeconds ?? 60;
  return new OpenAICompatibleProvider({
    id: config.id,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: options.apiKey,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    contextWindow: config.contextWindow,
    timeoutMs: timeoutSeconds * 1000,
    // A long answer may pause while the model thinks; allow more than the start timeout.
    idleTimeoutMs: Math.max(timeoutSeconds, 90) * 1000,
    toolCalling: config.toolCalling,
    redact: options.redact,
    fetchImpl: options.fetchImpl,
    retryBaseDelayMs: options.retryBaseDelayMs,
  });
}
