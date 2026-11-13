import { newId } from '../../shared/hash';
import { truncateToTokens } from '../../shared/tokens';
import { assessCommand } from '../commandRisk';
import { runCommand } from '../commandRunner';
import type { CommandRecord, ToolDefinition } from '../types';

const MAX_COMMAND_LENGTH = 2000;
const UI_OUTPUT_CHARS = 6000;
const MODEL_OUTPUT_TOKENS = 3000;

function tail(text: string, chars: number): string {
  return text.length > chars ? `[…]\n${text.slice(-chars)}` : text;
}

export const runCommandTool: ToolDefinition<{ command: string; purpose?: string }> = {
  name: 'run_command',
  description: [
    'Ask the user for permission to run a shell command in the workspace root, then run it and return its exit code and output.',
    'Use it to verify work with the project\'s own test, lint, type-check or build commands, or to inspect state.',
    'Every command needs approval, and the user may deny it. Run one command per call and keep it short-lived: no servers, watchers or interactive programs.',
    'Do not use this to edit files; use propose_changes for that.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND_LENGTH, description: 'The exact command line to run.' },
      purpose: { type: 'string', maxLength: 300, description: 'One sentence telling the user why this command is needed.' },
    },
    required: ['command'],
  },
  permission: 'execute',
  showsRow: false,
  describe: (args) => ({ title: `Ran ${args.command}` }),

  async execute(args, context) {
    const command = args.command.trim();
    const assessment = assessCommand(command);
    const remembered = assessment.canRemember && context.host.isCommandRemembered(command);
    const itemId = newId('k');
    const requestId = newId('q');

    context.events.add({
      kind: 'command',
      id: itemId,
      requestId,
      command,
      purpose: (args.purpose ?? '').trim(),
      risk: assessment.risk,
      riskReasons: assessment.reasons,
      canRemember: assessment.canRemember,
      remembered,
      status: remembered ? 'running' : 'pending',
      verification: assessment.isCheck,
    });

    const base: Omit<CommandRecord, 'status' | 'exitCode' | 'durationMs' | 'outputSummary'> = {
      command,
      verification: assessment.isCheck,
      sequence: context.record.sequence++,
    };

    if (!remembered) {
      let decision: 'once' | 'always' | 'deny';
      try {
        decision = await context.host.approveCommand({ requestId, command, risk: assessment.risk, reasons: assessment.reasons, canRemember: assessment.canRemember }, context.signal);
      } catch (err) {
        context.events.update(itemId, { status: 'cancelled' });
        throw err;
      }
      if (decision !== 'once' && decision !== 'always') {
        context.events.update(itemId, { status: 'denied' });
        context.record.commands.push({ ...base, status: 'denied', exitCode: null, durationMs: 0, outputSummary: '' });
        return {
          ok: false,
          content: `The user denied this command. It was NOT run: ${command}\nDo not ask for the same command again. Continue without it, or tell the user what could not be checked.`,
        };
      }
      // "Always" is honoured only for commands the classifier allows to be remembered.
      if (decision === 'always' && assessment.canRemember) {
        await context.host.rememberCommand(command);
        context.events.update(itemId, { remembered: true });
      }
      context.events.update(itemId, { status: 'running' });
    }

    const result = await runCommand(command, {
      cwd: context.index.root,
      timeoutMs: context.host.commandTimeoutMs,
      signal: context.signal,
      onOutput: (output) => context.events.update(itemId, { output: context.redact(tail(output, UI_OUTPUT_CHARS)) }),
    });

    const output = context.redact(result.output);
    context.events.update(itemId, {
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: tail(output, UI_OUTPUT_CHARS) || (result.error ? context.redact(result.error) : ''),
    });
    context.record.commands.push({
      ...base,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputSummary: tail(output, 1200),
    });
    // Commands may create, change or delete files.
    context.index.markDirty();

    const seconds = (result.durationMs / 1000).toFixed(1);
    const body = truncateToTokens(output.length > MODEL_OUTPUT_TOKENS * 3 ? tail(output, MODEL_OUTPUT_TOKENS * 3) : output, MODEL_OUTPUT_TOKENS).text;
    const shown = body ? `Output${result.truncated ? ' (shortened)' : ''}:\n${body}` : 'The command printed nothing.';

    if (result.status === 'error') return { ok: false, content: `The command could not be started: ${context.redact(result.error ?? 'unknown error')}` };
    if (result.status === 'timeout') {
      return { ok: false, content: `Command: ${command}\nThe command was stopped after ${seconds}s because it exceeded the time limit. It did not finish, so its result is unknown.\n${shown}` };
    }
    if (result.status === 'cancelled') return { ok: false, content: `Command: ${command}\nThe user stopped the command before it finished.` };
    return { ok: result.exitCode === 0, content: `Command: ${command}\nExit code: ${result.exitCode}\nDuration: ${seconds}s\n${shown}` };
  },
};
