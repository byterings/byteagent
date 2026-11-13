import * as vscode from 'vscode';
import { PROVIDER_PRESETS } from '../config/settings';
import { writeDefaultMode } from '../config/vscodeSettings';
import { describeError } from '../shared/errors';
import type { AppState, HostMessage, ViewName, WebviewMessage } from '../shared/protocol';
import { workspaceName, workspaceRoot, type Services } from './services';

export type Poster = (message: HostMessage) => void;

/**
 * Bridges the webview and the rest of the extension. All webview messages
 * arrive here; all state the webview shows is produced here.
 */
export class ChatController {
  private poster: Poster | undefined;
  private pendingView: ViewName | undefined;

  constructor(private readonly services: Services) {}

  attach(poster: Poster): void {
    this.poster = poster;
  }

  detach(): void {
    this.poster = undefined;
  }

  post(message: HostMessage): void {
    this.poster?.(message);
  }

  /** Switches the webview to a view, now or as soon as it is ready. */
  showView(view: ViewName): void {
    if (this.poster) this.post({ type: 'showView', view });
    else this.pendingView = view;
  }

  async buildState(): Promise<AppState> {
    const { settings, problems } = this.services.settings();
    const profiles = await this.services.profiles.list();
    return {
      ready: true,
      hasWorkspace: Boolean(workspaceRoot()),
      workspaceName: workspaceName(),
      profiles,
      activeProfileId: settings.activeProvider,
      presets: PROVIDER_PRESETS,
      settingsProblems: problems,
      defaultMode: settings.defaultMode,
      sessions: [],
      sessionId: '',
      items: [],
      busy: false,
      usage: null,
      tasks: [],
      projectInitialized: false,
      editor: {},
    };
  }

  async pushState(): Promise<void> {
    if (!this.poster) return;
    this.post({ type: 'state', state: await this.buildState() });
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      await this.dispatch(message);
    } catch (err) {
      this.services.logger.error(`Failed to handle "${message.type}"`, err);
      this.post({ type: 'toast', level: 'error', message: describeError(err) });
    }
  }

  private async dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        await this.pushState();
        if (this.pendingView) {
          this.post({ type: 'showView', view: this.pendingView });
          this.pendingView = undefined;
        }
        return;
      }
      case 'saveProfile': {
        const result = await this.services.profiles.save(message.draft, message.apiKey, message.makeActive);
        this.post({ type: 'profileSaved', requestId: message.requestId, ...result });
        if (result.ok) {
          this.services.logger.info(`Saved provider profile "${result.profileId}"`);
          await this.pushState();
        }
        return;
      }
      case 'deleteProfile': {
        await this.services.profiles.remove(message.id);
        this.services.logger.info(`Deleted provider profile "${message.id}"`);
        await this.pushState();
        return;
      }
      case 'setActiveProfile': {
        await this.services.profiles.setActive(message.id);
        await this.pushState();
        return;
      }
      case 'setModel': {
        const active = this.services.settings().settings.activeProvider;
        if (active) await this.services.profiles.setModel(active, message.model);
        await this.pushState();
        return;
      }
      case 'setMode': {
        await writeDefaultMode(message.mode);
        await this.pushState();
        return;
      }
      case 'openVsCodeSettings': {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:byteagent.byteagent');
        return;
      }
      case 'openExternal': {
        const uri = vscode.Uri.parse(message.url, true);
        if (uri.scheme === 'https' || uri.scheme === 'http') await vscode.env.openExternal(uri);
        return;
      }
      case 'copy': {
        await vscode.env.clipboard.writeText(message.text);
        return;
      }
      default:
        this.services.logger.debug(`Unhandled webview message "${message.type}"`);
    }
  }
}
