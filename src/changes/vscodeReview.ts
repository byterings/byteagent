import * as vscode from 'vscode';
import type { ChangeSet, ProposedChange } from './types';

const SCHEME = 'byteagent-review';
const MAX_KEPT = 30;

/**
 * Shows proposed changes in VS Code's diff editor. Both sides are read-only
 * snapshots: the left is the content the change was computed from, the
 * right is exactly what would be written.
 */
export class ChangeReviewService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly sets = new Map<string, ChangeSet>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  }

  dispose(): void {
    this.registration.dispose();
    this.sets.clear();
  }

  remember(changeSet: ChangeSet): void {
    this.sets.set(changeSet.id, changeSet);
    while (this.sets.size > MAX_KEPT) {
      const oldest = this.sets.keys().next().value;
      if (oldest === undefined) break;
      this.sets.delete(oldest);
    }
  }

  find(changeSetId: string, changeId: string): ProposedChange | undefined {
    return this.sets.get(changeSetId)?.changes.find((c) => c.id === changeId);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, setId, changeId, side] = uri.path.split('/');
    const change = setId && changeId ? this.find(setId, changeId) : undefined;
    if (!change) return '';
    return (side === 'base' ? change.baseContent : change.newContent) ?? '';
  }

  /** Opens the diff for one file. Returns false when the change is no longer known. */
  async openDiff(changeSetId: string, changeId: string): Promise<boolean> {
    const change = this.find(changeSetId, changeId);
    if (!change) return false;
    const uri = (side: 'base' | 'proposed'): vscode.Uri =>
      vscode.Uri.from({ scheme: SCHEME, path: `/${changeSetId}/${changeId}/${side}/${change.path}` });
    const label = change.kind === 'create' ? 'new file' : change.kind === 'delete' ? 'delete' : 'proposed change';
    await vscode.commands.executeCommand('vscode.diff', uri('base'), uri('proposed'), `${change.path} (${label})`, { preview: true });
    return true;
  }
}
