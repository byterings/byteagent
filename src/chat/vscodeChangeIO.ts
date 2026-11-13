import * as path from 'node:path';
import * as vscode from 'vscode';
import { NodeChangeIO } from '../changes/applier';
import type { ChangeIO } from '../changes/types';

/**
 * Writes approved changes. A file with unsaved edits is changed through
 * the editor and saved, because its approved base was the editor text.
 * Every other file is written to disk; VS Code reloads clean open tabs by
 * itself, which avoids save conflicts when its copy lags behind the disk.
 */
export class VsCodeChangeIO implements ChangeIO {
  constructor(private readonly root: () => string | undefined) {}

  private target(relativePath: string): { uri: vscode.Uri; root: string } {
    const root = this.root();
    if (!root) throw new Error('No workspace folder is open.');
    return { uri: vscode.Uri.file(path.join(root, ...relativePath.split('/'))), root };
  }

  async write(relativePath: string, content: string): Promise<void> {
    const { uri, root } = this.target(relativePath);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === uri.fsPath && !d.isClosed && d.isDirty);
    if (!open) {
      await new NodeChangeIO(root).write(relativePath, content);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const whole = new vscode.Range(new vscode.Position(0, 0), open.lineAt(Math.max(0, open.lineCount - 1)).rangeIncludingLineBreak.end);
    edit.replace(uri, whole, content);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The editor refused the edit.');
    if (!(await open.save())) throw new Error('The file could not be saved.');
  }

  async delete(relativePath: string): Promise<void> {
    const { uri } = this.target(relativePath);
    try {
      // Recoverable where the platform supports it.
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } catch {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    }
  }
}
