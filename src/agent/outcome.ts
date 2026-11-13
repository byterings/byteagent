import type { OutcomeView } from '../shared/protocol';
import type { CommandRecord, RunRecord } from '../tools/types';
import type { DiagnosticSummary } from './host';

/**
 * Builds the end-of-run summary from recorded facts only. Nothing the
 * model said is used here: a check counts as passed only when a command
 * actually ran and exited with code 0 after the last file change.
 */
export function buildOutcome(record: RunRecord, diagnostics: DiagnosticSummary | null): OutcomeView | undefined {
  const acted =
    record.applied.length > 0 || record.rejected.length > 0 || record.stale.length > 0 || record.failed.length > 0 || record.commands.length > 0;
  if (!acted) return undefined;

  const applied = [...new Set(record.applied)];
  const appliedSet = new Set(applied);
  // A file rejected in one proposal and applied in a later one counts as applied.
  const rejected = [...new Set(record.rejected)].filter((p) => !appliedSet.has(p));
  const failed = [
    ...record.failed.filter((f) => !appliedSet.has(f.path)),
    ...[...new Set(record.stale)].filter((p) => !appliedSet.has(p)).map((path) => ({ path, error: 'the file changed before the change could be applied' })),
  ];

  const ran = record.commands.filter((c) => c.status !== 'denied');
  const notes: string[] = [];
  for (const denied of record.commands.filter((c) => c.status === 'denied')) notes.push(`Not run, because you denied it: ${denied.command}`);
  for (const c of ran) {
    if (c.status === 'timeout') notes.push(`Stopped at the time limit, result unknown: ${c.command}`);
    else if (c.status === 'cancelled') notes.push(`Stopped before it finished: ${c.command}`);
    else if (c.status === 'error') notes.push(`Could not be started: ${c.command}`);
  }

  // Only the most recent run of each check counts: a test that failed and
  // then passed after a fix has passed.
  const latest = new Map<string, CommandRecord>();
  for (const c of ran) if (c.verification) latest.set(c.command, c);
  const checks = [...latest.values()];

  let verification: OutcomeView['verification'];
  if (checks.length === 0) verification = 'not_run';
  else if (checks.some((c) => c.status !== 'done' || c.exitCode !== 0)) verification = 'failed';
  else if (record.lastAppliedAt > Math.max(...checks.map((c) => c.sequence))) {
    verification = 'not_run';
    notes.push('Files were changed after the last check ran, so the final state has not been verified.');
  } else verification = 'passed';

  return {
    applied,
    rejected,
    failed,
    commands: ran.map((c) => ({ command: c.command, exitCode: c.exitCode, passed: c.status === 'done' && c.exitCode === 0, verification: c.verification })),
    diagnostics: applied.length > 0 ? diagnostics : null,
    verification,
    notes,
  };
}
