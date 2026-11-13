import * as path from 'node:path';
import * as vscode from 'vscode';
import { PathPolicy } from '../context/ignore';
import { toPosix } from '../context/paths';
import { findRipgrep } from '../context/search';
import { SymbolIndex } from '../context/symbols';
import { detectProject, summarizeFacts } from '../context/techDetect';
import { WorkspaceIndex } from '../context/workspaceIndex';
import type { EditorContext } from '../shared/protocol';
import { truncateToTokens } from '../shared/tokens';
import { workspaceRoot, type Services } from './services';

const RULES_FILES = ['AGENTS.md', '.byteagent/rules.md'];
const RULES_TOKEN_LIMIT = 1500;

/**
 * Owns the workspace index for the open folder and keeps it in step with
 * the editor: unsaved buffers, file events, settings and selections.
 */
export class WorkspaceService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private current: { root: string; index: WorkspaceIndex; policy: PathPolicy; symbols: SymbolIndex } | undefined;
  private signature = '';
  private facts: { at: number; text: string } | undefined;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private ripgrep: string | undefined | null = null;
  onEditorChanged: ((editor: EditorContext) => void) | undefined;

  constructor(private readonly services: Services) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.onFileEvent(uri, false)),
      watcher.onDidDelete((uri) => this.onFileEvent(uri, false)),
      watcher.onDidChange((uri) => this.onFileEvent(uri, true)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.current = undefined;
        this.notifyEditor();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.notifyEditor()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor !== vscode.window.activeTextEditor) return;
        if (this.selectionTimer) clearTimeout(this.selectionTimer);
        this.selectionTimer = setTimeout(() => this.notifyEditor(), 150);
      }),
    );
  }

  dispose(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    for (const d of this.disposables) d.dispose();
  }

  /** The index for the open folder, rebuilt when the folder or settings change. */
  get index(): WorkspaceIndex | undefined {
    const root = workspaceRoot();
    if (!root) {
      this.current = undefined;
      return undefined;
    }
    const { settings } = this.services.settings();
    const signature = JSON.stringify([root, settings.exclude, settings.maxFileSizeKb]);
    if (!this.current || this.signature !== signature) {
      const policy = new PathPolicy(root, { exclude: settings.exclude });
      const index = new WorkspaceIndex(root, policy, {
        maxFileSizeBytes: settings.maxFileSizeKb * 1024,
        overlay: (relative) => this.unsavedText(root, relative),
      });
      this.current = { root, index, policy, symbols: new SymbolIndex(index) };
      this.signature = signature;
      this.facts = undefined;
    }
    return this.current.index;
  }

  /** Declared names in the workspace, kept in step with the index. */
  get symbols(): SymbolIndex | undefined {
    return this.index ? this.current?.symbols : undefined;
  }

  get ripgrepPath(): string | undefined {
    if (this.ripgrep === null) {
      const appRoot = vscode.env.appRoot;
      const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
      this.ripgrep = findRipgrep([
        path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
        path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
        'rg',
      ]);
      this.services.logger.info(this.ripgrep ? `Using ripgrep at ${this.ripgrep}` : 'ripgrep not found; using built-in search');
    }
    return this.ripgrep;
  }

  /** Workspace-relative path of a document the agent is allowed to see. */
  relativePath(uri: vscode.Uri): string | undefined {
    const index = this.index;
    if (!index || uri.scheme !== 'file') return undefined;
    const rel = path.relative(index.root, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    try {
      return index.resolve(toPosix(rel));
    } catch {
      return undefined; // blocked by the exclusion policy
    }
  }

  editorContext(): EditorContext {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return {};
    const activeFile = this.relativePath(editor.document.uri);
    if (!activeFile) return {};
    const selection = editor.selection;
    if (selection.isEmpty) return { activeFile };
    let endLine = selection.end.line + 1;
    if (selection.end.character === 0 && selection.end.line > selection.start.line) endLine -= 1;
    return { activeFile, selection: { path: activeFile, startLine: selection.start.line + 1, endLine } };
  }

  openFiles(): string[] {
    const out: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const rel = this.relativePath(tab.input.uri);
          if (rel && !out.includes(rel)) out.push(rel);
        }
      }
    }
    return out;
  }

  /** Detected stack summary, refreshed at most once a minute. */
  async projectFacts(): Promise<string> {
    const index = this.index;
    if (!index) return '';
    if (this.facts && Date.now() - this.facts.at < 60_000) return this.facts.text;
    try {
      const text = summarizeFacts(await detectProject(index));
      this.facts = { at: Date.now(), text };
      return text;
    } catch (err) {
      this.services.logger.warn('Project detection failed', err);
      return '';
    }
  }

  /** Developer-written rules for agents, when the project has them. */
  async projectRules(): Promise<string> {
    const index = this.index;
    if (!index) return '';
    for (const file of RULES_FILES) {
      try {
        const { text } = await index.readText(file);
        if (text.trim()) return `From ${file}:\n${truncateToTokens(text.trim(), RULES_TOKEN_LIMIT).text}`;
      } catch {
        // not present or not readable
      }
    }
    return '';
  }

  /** The project's own knowledge file, written during setup and edited by the developer. */
  async projectKnowledge(): Promise<string> {
    const index = this.index;
    if (!index) return '';
    try {
      const { text } = await index.readText('.byteagent/context.md');
      return text.trim() ? `Project knowledge from .byteagent/context.md:\n${truncateToTokens(text.trim(), RULES_TOKEN_LIMIT).text}` : '';
    } catch {
      return '';
    }
  }

  private unsavedText(root: string, relative: string): string | undefined {
    const target = path.join(root, ...relative.split('/'));
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && document.uri.scheme === 'file' && document.uri.fsPath === target) return document.getText();
    }
    return undefined;
  }

  private onFileEvent(uri: vscode.Uri, contentOnly: boolean): void {
    const current = this.current;
    if (!current || uri.scheme !== 'file') return;
    const rel = path.relative(current.root, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const posix = toPosix(rel);
    if (posix.endsWith('.gitignore')) {
      current.policy.reset();
      current.index.markDirty();
      return;
    }
    if (contentOnly) current.index.invalidate(posix);
    void current.index.refreshPath(posix);
    if (/(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|Makefile)$/.test(posix)) this.facts = undefined;
  }

  private notifyEditor(): void {
    this.onEditorChanged?.(this.editorContext());
  }
}
