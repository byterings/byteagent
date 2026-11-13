import { spawn } from 'node:child_process';

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called with the output so far, at most a few times per second. */
  onOutput?: (output: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  status: 'done' | 'timeout' | 'cancelled' | 'error';
  /** Null when the process did not exit by itself. */
  exitCode: number | null;
  durationMs: number;
  /** stdout and stderr in arrival order, with the middle removed when very long. */
  output: string;
  /** True when part of the output was dropped. */
  truncated: boolean;
  /** Set when the process could not be started. */
  error?: string;
}

const HEAD_BYTES = 12 * 1024;
const TAIL_BYTES = 36 * 1024;
const KILL_GRACE_MS = 1500;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

/** Keeps the start and the end of long output; errors are usually at the end. */
class OutputBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;

  append(chunk: string): void {
    if (this.head.length < HEAD_BYTES) {
      const room = HEAD_BYTES - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (!chunk) return;
    }
    this.tail += chunk;
    if (this.tail.length > TAIL_BYTES) {
      this.dropped += this.tail.length - TAIL_BYTES;
      this.tail = this.tail.slice(-TAIL_BYTES);
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n[… ${this.dropped} characters of output removed …]\n${this.tail}`;
  }
}

function killTree(pid: number, force: boolean): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Negative pid: the whole process group started for this command.
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    // already gone
  }
}

/**
 * Runs a shell command in the workspace with a time limit, cancellation
 * and bounded output. This function does not decide whether a command may
 * run; the caller must have obtained approval.
 */
export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const buffer = new OutputBuffer();
    let status: CommandResult['status'] = 'done';
    let settled = false;
    let lastEmit = 0;

    if (options.signal?.aborted) {
      resolve({ status: 'cancelled', exitCode: null, durationMs: 0, output: '', truncated: false });
      return;
    }

    let child;
    try {
      child = spawn(command, {
        cwd: options.cwd,
        shell: true,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // No terminal is attached: tools should not prompt, colour, or watch.
        env: { ...(options.env ?? process.env), CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
      });
    } catch (err) {
      resolve({ status: 'error', exitCode: null, durationMs: Date.now() - started, output: '', truncated: false, error: (err as Error).message });
      return;
    }

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: 'timeout' | 'cancelled'): void => {
      if (settled || status !== 'done') return;
      status = reason;
      if (child.pid) {
        killTree(child.pid, false);
        killTimer = setTimeout(() => child.pid && killTree(child.pid, true), KILL_GRACE_MS);
      }
    };

    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const onAbort = (): void => stop('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        status: error ? 'error' : status,
        exitCode: status === 'done' && !error ? exitCode : null,
        durationMs: Date.now() - started,
        output: stripAnsi(buffer.toString()).trimEnd(),
        truncated: buffer.truncated,
        error,
      });
    };

    const onData = (chunk: Buffer): void => {
      buffer.append(chunk.toString('utf8'));
      if (options.onOutput && Date.now() - lastEmit > 400) {
        lastEmit = Date.now();
        options.onOutput(stripAnsi(buffer.toString()));
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}
