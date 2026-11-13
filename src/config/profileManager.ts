import type { FieldProblem, ProfileDraft, ProfileView } from '../shared/protocol';
import {
  makeProfileId,
  validateProfile,
  type ByteAgentSettings,
  type ProviderProfile,
} from './settings';

/** Storage the manager needs. Implemented with VS Code APIs in production. */
export interface ProfileBackend {
  readSettings(): ByteAgentSettings;
  writeProviders(providers: ProviderProfile[], activeProvider: string): Promise<void>;
  getApiKey(profileId: string): Promise<string | undefined>;
  hasApiKey(profileId: string): Promise<boolean>;
  setApiKey(profileId: string, apiKey: string): Promise<void>;
  deleteApiKey(profileId: string): Promise<void>;
}

export interface SaveResult {
  ok: boolean;
  errors: FieldProblem[];
  warnings: FieldProblem[];
  profileId?: string;
}

/**
 * Creates, updates and deletes provider profiles. Keys go to the secret
 * backend only; they are never part of a profile object.
 */
export class ProfileManager {
  constructor(private readonly backend: ProfileBackend) {}

  async list(): Promise<ProfileView[]> {
    const { providers } = this.backend.readSettings();
    return Promise.all(
      providers.map(async (p) => ({ ...p, hasKey: await this.backend.hasApiKey(p.id) })),
    );
  }

  /** Validates a draft without saving it. Assigns an id to new drafts. */
  check(draft: ProfileDraft): { result: ReturnType<typeof validateProfile>; isNew: boolean } {
    const { providers } = this.backend.readSettings();
    const isNew = !draft.id || !providers.some((p) => p.id === draft.id);
    const id = isNew
      ? makeProfileId(
          draft.name || 'provider',
          providers.map((p) => p.id),
        )
      : draft.id;
    return { result: validateProfile({ ...draft, id }), isNew };
  }

  async save(draft: ProfileDraft, apiKey: string | null | undefined, makeActive: boolean): Promise<SaveResult> {
    const { result, isNew } = this.check(draft);
    if (!result.ok || !result.profile) {
      return { ok: false, errors: result.errors, warnings: result.warnings };
    }
    const profile = result.profile;
    const settings = this.backend.readSettings();

    const clash = settings.providers.find(
      (p) => p.id !== profile.id && p.name.toLowerCase() === profile.name.toLowerCase(),
    );
    if (clash) {
      return {
        ok: false,
        errors: [{ field: 'name', message: 'Another provider already uses this name.' }],
        warnings: result.warnings,
      };
    }

    const providers = isNew
      ? [...settings.providers, profile]
      : settings.providers.map((p) => (p.id === profile.id ? profile : p));
    const active = makeActive || !settings.activeProvider ? profile.id : settings.activeProvider;

    if (typeof apiKey === 'string' && apiKey.trim()) await this.backend.setApiKey(profile.id, apiKey);
    else if (apiKey === null) await this.backend.deleteApiKey(profile.id);

    await this.backend.writeProviders(providers, active);
    return { ok: true, errors: [], warnings: result.warnings, profileId: profile.id };
  }

  async remove(profileId: string): Promise<void> {
    const settings = this.backend.readSettings();
    const providers = settings.providers.filter((p) => p.id !== profileId);
    if (providers.length === settings.providers.length) return;
    const active =
      settings.activeProvider === profileId ? (providers[0]?.id ?? '') : settings.activeProvider;
    await this.backend.deleteApiKey(profileId);
    await this.backend.writeProviders(providers, active);
  }

  async setActive(profileId: string): Promise<boolean> {
    const settings = this.backend.readSettings();
    if (!settings.providers.some((p) => p.id === profileId)) return false;
    await this.backend.writeProviders(settings.providers, profileId);
    return true;
  }

  async setModel(profileId: string, model: string): Promise<boolean> {
    const settings = this.backend.readSettings();
    const target = settings.providers.find((p) => p.id === profileId);
    const trimmed = model.trim();
    if (!target || !trimmed) return false;
    const check = validateProfile({ ...target, model: trimmed });
    if (!check.ok || !check.profile) return false;
    const updated = check.profile;
    await this.backend.writeProviders(
      settings.providers.map((p) => (p.id === profileId ? updated : p)),
      settings.activeProvider,
    );
    return true;
  }

  /**
   * Resolves the key to use for a draft: an explicitly typed key wins,
   * otherwise the stored key of the profile being edited.
   */
  async resolveKey(draft: ProfileDraft, typed: string | null | undefined): Promise<string | undefined> {
    if (typeof typed === 'string' && typed.trim()) return typed.trim();
    if (typed === null) return undefined;
    return draft.id ? this.backend.getApiKey(draft.id) : undefined;
  }
}
