import * as vscode from 'vscode';
import { createLogger, type Logger, type LogLevel } from './logger';
import type { Redactor } from './redact';

export interface ChannelLogger {
  logger: Logger;
  channel: vscode.OutputChannel;
}

/** A redacting logger that writes to the "ByteAgent" output channel. */
export function createChannelLogger(redactor: Redactor, level: LogLevel): ChannelLogger {
  const channel = vscode.window.createOutputChannel('ByteAgent');
  const logger = createLogger((line) => channel.appendLine(line), redactor, level);
  return { logger, channel };
}
