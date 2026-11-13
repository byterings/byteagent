import * as vscode from 'vscode';
import type { WebviewMessage } from '../shared/protocol';
import type { ChatController } from './controller';
import { buildWebviewHtml } from './webviewHtml';

export const CHAT_VIEW_ID = 'byteagent.chat';

/** Hosts the chat UI in the ByteAgent sidebar. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = buildWebviewHtml(view.webview, this.extensionUri);

    this.controller.attach((message) => {
      void view.webview.postMessage(message);
    });
    const subscription = view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.controller.handleMessage(message);
    });
    view.onDidDispose(() => {
      subscription.dispose();
      this.controller.detach();
      this.view = undefined;
    });
  }

  /** Reveals the chat view, opening the sidebar if needed. */
  async reveal(): Promise<void> {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  }
}
