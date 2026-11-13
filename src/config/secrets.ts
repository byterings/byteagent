import type * as vscode from 'vscode';
import type { Redactor } from '../shared/redact';

const PREFIX = 'byteagent.apiKey.';

/**
 * API keys live only in VS Code SecretStorage. Every key that is read is
 * registered with the redactor so it can never be written to a log.
 */
export class SecretStore {
  constructor(
    private readonly storage: vscode.SecretStorage,
    private readonly redactor: Redactor,
  ) {}

  async getApiKey(profileId: string): Promise<string | undefined> {
    const key = await this.storage.get(PREFIX + profileId);
    if (key) this.redactor.addSecret(key);
    return key || undefined;
  }

  async hasApiKey(profileId: string): Promise<boolean> {
    return Boolean(await this.storage.get(PREFIX + profileId));
  }

  async setApiKey(profileId: string, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      await this.deleteApiKey(profileId);
      return;
    }
    this.redactor.addSecret(trimmed);
    await this.storage.store(PREFIX + profileId, trimmed);
  }

  async deleteApiKey(profileId: string): Promise<void> {
    await this.storage.delete(PREFIX + profileId);
  }
}
