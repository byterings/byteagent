import * as vscode from 'vscode';
import { parseSettings, type ParsedSettings, type ProviderProfile } from './settings';

const SECTION = 'byteagent';

const KEYS = [
  'providers',
  'activeProvider',
  'agent.defaultMode',
  'context.exclude',
  'context.maxFileSizeKb',
  'context.defaultContextWindow',
  'context.confirmBeforeSend',
  'commands.timeoutSeconds',
  'logLevel',
] as const;

/** Reads and validates the current ByteAgent configuration. */
export function readSettings(): ParsedSettings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const raw: Record<string, unknown> = {};
  for (const key of KEYS) raw[key] = config.get(key);
  return parseSettings(raw);
}

/** Provider profiles are user-level: they apply to every workspace. */
export async function writeProviders(providers: ProviderProfile[], activeProvider: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  await config.update('providers', providers, vscode.ConfigurationTarget.Global);
  await config.update('activeProvider', activeProvider, vscode.ConfigurationTarget.Global);
}

export async function writeActiveProvider(activeProvider: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  await config.update('activeProvider', activeProvider, vscode.ConfigurationTarget.Global);
}

export async function writeDefaultMode(mode: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  await config.update('agent.defaultMode', mode, vscode.ConfigurationTarget.Global);
}

export function onSettingsChanged(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) listener();
  });
}
