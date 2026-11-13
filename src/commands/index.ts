import * as vscode from 'vscode';
import type { ChatViewProvider } from '../chat/chatViewProvider';
import type { ChatController } from '../chat/controller';
import type { Services } from '../chat/services';
import { describeError } from '../shared/errors';

export const COMMANDS = {
  openChat: 'byteagent.openChat',
  newChat: 'byteagent.newChat',
  showHistory: 'byteagent.showHistory',
  openSettings: 'byteagent.openSettings',
  setApiKey: 'byteagent.setApiKey',
  clearApiKey: 'byteagent.clearApiKey',
  testConnection: 'byteagent.testConnection',
  initProject: 'byteagent.initProject',
  addSelectionToChat: 'byteagent.addSelectionToChat',
  showLogs: 'byteagent.showLogs',
  resetCommandApprovals: 'byteagent.resetCommandApprovals',
} as const;

export interface CommandDeps {
  services: Services;
  controller: ChatController;
  view: ChatViewProvider;
}

type Handler = (...args: unknown[]) => unknown;

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { services, controller, view } = deps;

  const register = (id: string, handler: Handler): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (err) {
          services.logger.error(`Command ${id} failed`, err);
          void vscode.window.showErrorMessage(`ByteAgent: ${describeError(err)}`);
          return undefined;
        }
      }),
    );
  };

  register(COMMANDS.openChat, async () => {
    await view.reveal();
    controller.showView('chat');
  });

  register(COMMANDS.openSettings, async () => {
    await view.reveal();
    controller.showView('settings');
  });

  register(COMMANDS.showHistory, async () => {
    await view.reveal();
    controller.showView('history');
  });

  register(COMMANDS.showLogs, () => {
    services.logChannel.show(true);
  });

  register(COMMANDS.setApiKey, async (profileIdArg?: unknown) => {
    const profileId = await pickProfile(services, profileIdArg, 'Set the API key for which provider?');
    if (!profileId) return false;
    const key = await vscode.window.showInputBox({
      title: 'ByteAgent API key',
      prompt: 'Stored in VS Code secret storage. It is never written to settings or logs.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a key, or press Escape to cancel.'),
    });
    if (!key) return false;
    await services.secrets.setApiKey(profileId, key);
    services.logger.info(`Stored API key for profile "${profileId}"`);
    await controller.pushState();
    void vscode.window.showInformationMessage('ByteAgent: API key saved.');
    return true;
  });

  register(COMMANDS.clearApiKey, async (profileIdArg?: unknown) => {
    const profileId = await pickProfile(services, profileIdArg, 'Remove the API key of which provider?');
    if (!profileId) return false;
    await services.secrets.deleteApiKey(profileId);
    services.logger.info(`Removed API key for profile "${profileId}"`);
    await controller.pushState();
    void vscode.window.showInformationMessage('ByteAgent: API key removed.');
    return true;
  });

  register(COMMANDS.newChat, async () => {
    await view.reveal();
    await controller.newChat();
  });

  register(COMMANDS.testConnection, async () => {
    const { settings } = services.settings();
    const profile = settings.providers.find((p) => p.id === settings.activeProvider);
    if (!profile) {
      await vscode.commands.executeCommand(COMMANDS.openSettings);
      return false;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `ByteAgent: testing ${profile.name}…` },
      () => controller.testDraft(profile, undefined),
    );
    if (result.ok) void vscode.window.showInformationMessage(`ByteAgent: ${result.message}`);
    else void vscode.window.showErrorMessage(`ByteAgent: ${result.message}`);
    return result.ok;
  });

  register(COMMANDS.addSelectionToChat, async () => {
    await view.reveal();
    if (!controller.addSelectionToChat()) {
      void vscode.window.showInformationMessage('ByteAgent: open a file in this workspace first. Files excluded from ByteAgent cannot be added.');
    }
  });

  register(COMMANDS.resetCommandApprovals, async () => {
    const count = controller.rememberedCommands().length;
    await controller.forgetCommands();
    void vscode.window.showInformationMessage(
      count === 0 ? 'ByteAgent: no commands were set to always allow in this workspace.' : `ByteAgent: forgot ${count} always-allowed command${count === 1 ? '' : 's'}. You will be asked again.`,
    );
    return count;
  });

  // Commands whose features arrive in later milestones still respond.
  const later: Array<[string, string]> = [
    [COMMANDS.initProject, 'Project knowledge'],
  ];
  for (const [id, feature] of later) {
    register(id, () => {
      void vscode.window.showInformationMessage(`ByteAgent: ${feature} is not available in this build yet.`);
    });
  }
}

async function pickProfile(services: Services, arg: unknown, title: string): Promise<string | undefined> {
  const { settings } = services.settings();
  if (typeof arg === 'string' && settings.providers.some((p) => p.id === arg)) return arg;
  if (settings.providers.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'ByteAgent: add a provider first.',
      'Open Provider Settings',
    );
    if (choice) await vscode.commands.executeCommand(COMMANDS.openSettings);
    return undefined;
  }
  if (settings.providers.length === 1) return settings.providers[0]?.id;
  const picked = await vscode.window.showQuickPick(
    settings.providers.map((p) => ({
      label: p.name,
      description: p.id === settings.activeProvider ? 'active' : undefined,
      detail: p.baseUrl,
      id: p.id,
    })),
    { title },
  );
  return picked?.id;
}
