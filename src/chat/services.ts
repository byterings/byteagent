import * as vscode from 'vscode';
import { ProfileManager, type ProfileBackend } from '../config/profileManager';
import { SecretStore } from '../config/secrets';
import type { ParsedSettings } from '../config/settings';
import { readSettings, writeProviders } from '../config/vscodeSettings';
import type { Logger } from '../shared/logger';
import { Redactor } from '../shared/redact';
import { createChannelLogger } from '../shared/vscodeLogger';
import { WorkspaceService } from './workspaceService';

/** Long-lived objects shared by commands and the chat controller. */
export interface Services {
  context: vscode.ExtensionContext;
  redactor: Redactor;
  logger: Logger;
  logChannel: vscode.OutputChannel;
  secrets: SecretStore;
  profiles: ProfileManager;
  workspace: WorkspaceService;
  settings(): ParsedSettings;
}

export function createServices(context: vscode.ExtensionContext): Services {
  const redactor = new Redactor();
  const initial = readSettings();
  const { logger, channel } = createChannelLogger(redactor, initial.settings.logLevel);
  context.subscriptions.push(channel);

  const secrets = new SecretStore(context.secrets, redactor);

  const backend: ProfileBackend = {
    readSettings: () => readSettings().settings,
    writeProviders,
    getApiKey: (id) => secrets.getApiKey(id),
    hasApiKey: (id) => secrets.hasApiKey(id),
    setApiKey: (id, key) => secrets.setApiKey(id, key),
    deleteApiKey: (id) => secrets.deleteApiKey(id),
  };

  const services: Services = {
    context,
    redactor,
    logger,
    logChannel: channel,
    secrets,
    profiles: new ProfileManager(backend),
    workspace: undefined as unknown as WorkspaceService,
    settings: readSettings,
  };
  services.workspace = new WorkspaceService(services);
  context.subscriptions.push(services.workspace);
  return services;
}

/** The first workspace folder on the local file system, if any. */
export function workspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
  return folder?.uri.fsPath;
}

export function workspaceName(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? '';
}
