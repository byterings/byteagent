import * as vscode from 'vscode';
import type { ByteAgentApi } from '../../src/extension';

export const EXTENSION_ID = 'byteagent.byteagent';

export async function activate(): Promise<ByteAgentApi> {
  const extension = vscode.extensions.getExtension<ByteAgentApi>(EXTENSION_ID);
  if (!extension) throw new Error(`Extension ${EXTENSION_ID} is not installed in the test host`);
  return extension.isActive ? extension.exports : extension.activate();
}

export async function resetSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration('byteagent');
  for (const key of ['providers', 'activeProvider', 'agent.defaultMode', 'context.exclude', 'context.confirmBeforeSend']) {
    await config.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
