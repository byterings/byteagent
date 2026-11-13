import type { Redactor } from './redact';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  setLevel(level: LogLevel): void;
}

export type LogSink = (line: string) => void;

/**
 * Creates a logger whose every line passes through the redactor. There is
 * no way to write an unredacted line through this interface.
 */
export function createLogger(sink: LogSink, redactor: Redactor, initial: LogLevel = 'info'): Logger {
  let level = initial;

  const write = (lvl: LogLevel, message: string, data?: unknown): void => {
    if (ORDER[lvl] > ORDER[level]) return;
    let line = `${new Date().toISOString()} [${lvl}] ${message}`;
    if (data !== undefined) line += ` ${safeStringify(data)}`;
    sink(redactor.redact(line));
  };

  return {
    error: (m, d) => write('error', m, d),
    warn: (m, d) => write('warn', m, d),
    info: (m, d) => write('info', m, d),
    debug: (m, d) => write('debug', m, d),
    setLevel: (l) => {
      level = l;
    },
  };
}

function safeStringify(data: unknown): string {
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  if (typeof data === 'string') return data;
  try {
    const text = JSON.stringify(data);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return '[unserialisable]';
  }
}

export const nullLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  setLevel: () => {},
};
