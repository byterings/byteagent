import { beforeEach, describe, expect, it } from 'vitest';
import { ProfileManager, type ProfileBackend } from '../../src/config/profileManager';
import { DEFAULT_SETTINGS, type ByteAgentSettings, type ProviderProfile } from '../../src/config/settings';

function memoryBackend(): ProfileBackend & { settings: ByteAgentSettings; keys: Map<string, string> } {
  const state = {
    settings: { ...DEFAULT_SETTINGS, providers: [] as ProviderProfile[] },
    keys: new Map<string, string>(),
  };
  return {
    ...state,
    readSettings: () => state.settings,
    writeProviders: async (providers, activeProvider) => {
      state.settings = { ...state.settings, providers, activeProvider };
    },
    getApiKey: async (id) => state.keys.get(id),
    hasApiKey: async (id) => state.keys.has(id),
    setApiKey: async (id, key) => void state.keys.set(id, key.trim()),
    deleteApiKey: async (id) => void state.keys.delete(id),
    get settings() {
      return state.settings;
    },
  } as ProfileBackend & { settings: ByteAgentSettings; keys: Map<string, string> };
}

const draft = { id: '', name: 'Local', baseUrl: 'localhost:11434/v1', model: 'm' };

describe('ProfileManager', () => {
  let backend: ReturnType<typeof memoryBackend>;
  let manager: ProfileManager;
  beforeEach(() => {
    backend = memoryBackend();
    manager = new ProfileManager(backend);
  });

  it('creates a profile, assigns an id, stores the key separately and activates it', async () => {
    const result = await manager.save(draft, 'key-123456', false);
    expect(result).toMatchObject({ ok: true, profileId: 'local' });
    expect(backend.settings.providers[0]).toEqual({
      id: 'local',
      name: 'Local',
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
    });
    expect(backend.settings.activeProvider).toBe('local');
    expect(backend.keys.get('local')).toBe('key-123456');
    expect(JSON.stringify(backend.settings)).not.toContain('key-123456');
  });

  it('never exposes the key in the profile list', async () => {
    await manager.save(draft, 'key-123456', true);
    const list = await manager.list();
    expect(list[0]?.hasKey).toBe(true);
    expect(JSON.stringify(list)).not.toContain('key-123456');
  });

  it('returns field errors and saves nothing for an invalid draft', async () => {
    const result = await manager.save({ ...draft, baseUrl: 'ftp://x' }, 'k-abcdef', true);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe('baseUrl');
    expect(backend.settings.providers).toHaveLength(0);
    expect(backend.keys.size).toBe(0);
  });

  it('updates an existing profile and keeps the key when none is given', async () => {
    await manager.save(draft, 'key-123456', true);
    const result = await manager.save({ ...draft, id: 'local', model: 'm2' }, undefined, false);
    expect(result.ok).toBe(true);
    expect(backend.settings.providers).toHaveLength(1);
    expect(backend.settings.providers[0]?.model).toBe('m2');
    expect(backend.keys.get('local')).toBe('key-123456');
  });

  it('removes the key when asked with null', async () => {
    await manager.save(draft, 'key-123456', true);
    await manager.save({ ...draft, id: 'local' }, null, false);
    expect(backend.keys.has('local')).toBe(false);
  });

  it('rejects a second profile with the same name', async () => {
    await manager.save(draft, undefined, true);
    const result = await manager.save({ ...draft, name: 'local' }, undefined, true);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe('name');
  });

  it('keeps the current active profile unless asked to switch', async () => {
    await manager.save(draft, undefined, true);
    await manager.save({ ...draft, name: 'Second' }, undefined, false);
    expect(backend.settings.activeProvider).toBe('local');
    await manager.save({ ...draft, name: 'Third' }, undefined, true);
    expect(backend.settings.activeProvider).toBe('third');
  });

  it('deletes a profile with its key and moves the active profile', async () => {
    await manager.save(draft, 'key-123456', true);
    await manager.save({ ...draft, name: 'Second' }, 'key-abcdef', false);
    await manager.remove('local');
    expect(backend.settings.providers.map((p) => p.id)).toEqual(['second']);
    expect(backend.settings.activeProvider).toBe('second');
    expect(backend.keys.has('local')).toBe(false);
    await manager.remove('second');
    expect(backend.settings.activeProvider).toBe('');
  });

  it('switches active profile and model only for known, valid values', async () => {
    await manager.save(draft, undefined, true);
    expect(await manager.setActive('nope')).toBe(false);
    expect(await manager.setModel('local', '  ')).toBe(false);
    expect(await manager.setModel('local', 'new-model')).toBe(true);
    expect(backend.settings.providers[0]?.model).toBe('new-model');
  });

  it('resolves the typed key first, then the stored key', async () => {
    await manager.save(draft, 'stored-key-1', true);
    expect(await manager.resolveKey({ ...draft, id: 'local' }, 'typed-key-1')).toBe('typed-key-1');
    expect(await manager.resolveKey({ ...draft, id: 'local' }, undefined)).toBe('stored-key-1');
    expect(await manager.resolveKey({ ...draft, id: 'local' }, null)).toBeUndefined();
    expect(await manager.resolveKey(draft, undefined)).toBeUndefined();
  });
});
