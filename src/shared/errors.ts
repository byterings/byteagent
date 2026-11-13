/**
 * Structured errors. Every failure that can reach the user carries a stable
 * code and a message that is safe to display.
 */

export type ErrorCode =
  | 'config_invalid'
  | 'no_provider'
  | 'no_workspace'
  | 'path_outside_workspace'
  | 'path_excluded'
  | 'path_sensitive'
  | 'file_too_large'
  | 'binary_file'
  | 'not_found'
  | 'stale_file'
  | 'invalid_arguments'
  | 'permission_denied'
  | 'tool_not_found'
  | 'command_failed'
  | 'cancelled'
  | 'storage'
  | 'internal';

export class ByteAgentError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ByteAgentError';
    this.code = code;
    this.details = details;
  }
}

export type ProviderErrorCode =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'server'
  | 'bad_request'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'bad_stream'
  | 'tools_unsupported';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  /** Seconds the provider asked us to wait, when it said so. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get retryable(): boolean {
    return this.code === 'rate_limit' || this.code === 'server' || this.code === 'network';
  }
}

export function isCancellation(err: unknown): boolean {
  if (err instanceof ProviderError) return err.code === 'cancelled';
  if (err instanceof ByteAgentError) return err.code === 'cancelled';
  return err instanceof Error && err.name === 'AbortError';
}

/** A short, display-safe description of any thrown value. */
export function describeError(err: unknown): string {
  if (err instanceof ProviderError) return providerErrorHint(err);
  if (err instanceof ByteAgentError) return err.message;
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function providerErrorHint(err: ProviderError): string {
  switch (err.code) {
    case 'auth':
      return `The provider rejected the API key (${err.status ?? 'auth error'}). Check the key in Provider Settings.`;
    case 'not_found':
      return `The provider could not find that endpoint or model (404). Check the base URL and model name. ${err.message}`.trim();
    case 'rate_limit':
      return `The provider is rate limiting requests (429). ${err.retryAfterSeconds ? `Try again in ${err.retryAfterSeconds}s.` : 'Try again shortly.'}`;
    case 'server':
      return `The provider had a server error (${err.status ?? '5xx'}). ${err.message}`.trim();
    case 'bad_request':
      return `The provider rejected the request. ${err.message}`.trim();
    case 'network':
      return `Could not reach the provider. Check the base URL and your connection. ${err.message}`.trim();
    case 'timeout':
      return 'The provider did not respond in time. You can raise the timeout in Provider Settings.';
    case 'cancelled':
      return 'Stopped.';
    case 'bad_stream':
      return `The provider sent a response ByteAgent could not read. ${err.message}`.trim();
    case 'tools_unsupported':
      return 'This endpoint does not support tool calling.';
  }
}
