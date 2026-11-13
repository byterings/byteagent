import type * as vscode from 'vscode';
import type { Redactor } from '../shared/redact';

const PREFIX = 'byteagent.apiKey.';

/**
 * VS Code's secret storage can return the previous value for a short time
 * after a write. Recent writes are remembered so a read always sees them.
 */
const RECENT_WRITE_MS = 5000;

/**
 * API keys live only in VS Code SecretStorage. Every key that is read is
 * registered with the redactor so it can never be written to a log.
 */
export class SecretStore {
  private readonly recent = new Map<string, { value: string | undefined; at: number }>();

  constructor(
    private readonly storage: vscode.SecretStorage,
    private readonly redactor: Redactor,
  ) {}

  async getApiKey(profileId: string): Promise<string | undefined> {
    const written = this.recent.get(profileId);
    if (written) {
      if (Date.now() - written.at < RECENT_WRITE_MS) return written.value;
      this.recent.delete(profileId);
    }
    const key = await this.storage.get(PREFIX + profileId);
    if (key) this.redactor.addSecret(key);
    return key || undefined;
  }

  async hasApiKey(profileId: string): Promise<boolean> {
    return Boolean(await this.getApiKey(profileId));
  }

  async setApiKey(profileId: string, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      await this.deleteApiKey(profileId);
      return;
    }
    this.redactor.addSecret(trimmed);
    await this.storage.store(PREFIX + profileId, trimmed);
    this.recent.set(profileId, { value: trimmed, at: Date.now() });
  }

  async deleteApiKey(profileId: string): Promise<void> {
    await this.storage.delete(PREFIX + profileId);
    this.recent.set(profileId, { value: undefined, at: Date.now() });
  }
}
