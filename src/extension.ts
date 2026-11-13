import * as vscode from 'vscode';
import { CHAT_VIEW_ID, ChatViewProvider } from './chat/chatViewProvider';
import { ChatController } from './chat/controller';
import { createServices, type Services } from './chat/services';
import { registerCommands } from './commands';
import { onSettingsChanged } from './config/vscodeSettings';

/** Returned from activate() so extension tests can reach internals. */
export interface ByteAgentApi {
  services: Services;
  controller: ChatController;
}

export function activate(context: vscode.ExtensionContext): ByteAgentApi {
  const services = createServices(context);
  const controller = new ChatController(services);
  const view = new ChatViewProvider(context.extensionUri, controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  registerCommands(context, { services, controller, view });

  context.subscriptions.push(
    onSettingsChanged(() => {
      const { settings, problems } = services.settings();
      services.logger.setLevel(settings.logLevel);
      for (const problem of problems) {
        services.logger.warn(`Setting ${problem.setting}: ${problem.message}`);
      }
      void controller.pushState();
    }),
  );

  const { problems } = services.settings();
  for (const problem of problems) services.logger.warn(`Setting ${problem.setting}: ${problem.message}`);
  services.logger.info(`ByteAgent ${String(context.extension.packageJSON.version)} activated`);

  return { services, controller };
}

export function deactivate(): void {
  // Disposables registered on the extension context are released by VS Code.
}
