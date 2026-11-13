import { useEffect, useMemo, useState } from 'react';
import type { FieldProblem, PresetView, ProfileDraft, ProfileView } from '../../../src/shared/protocol';
import { Icon, Spinner } from '../icons';
import { useReply, useStore } from '../store';
import { post, requestId } from '../vscode';

type KeyAction = 'keep' | 'replace' | 'remove';

interface FormState {
  draft: ProfileDraft;
  presetId: string;
  apiKey: string;
  keyAction: KeyAction;
}

function emptyDraft(): ProfileDraft {
  return { id: '', name: '', baseUrl: '', model: '', toolCalling: 'auto' };
}

function toDraft(profile: ProfileView): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    temperature: profile.temperature ?? '',
    maxOutputTokens: profile.maxOutputTokens ?? '',
    contextWindow: profile.contextWindow ?? '',
    timeoutSeconds: profile.timeoutSeconds ?? '',
    toolCalling: profile.toolCalling ?? 'auto',
  };
}

export function SettingsView() {
  const { state, dispatch } = useStore();
  const { profiles, activeProfileId, presets, settingsProblems } = state.app;
  const [editing, setEditing] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // First run: go straight to the form.
  const firstRun = state.app.ready && profiles.length === 0;
  useEffect(() => {
    if (firstRun && !editing) {
      setEditing({ draft: emptyDraft(), presetId: '', apiKey: '', keyAction: 'replace' });
    }
  }, [firstRun, editing]);

  if (editing) {
    return (
      <ProfileForm
        key={editing.draft.id || 'new'}
        initial={editing}
        presets={presets}
        existing={profiles.find((p) => p.id === editing.draft.id)}
        firstRun={firstRun}
        onClose={() => {
          setEditing(null);
          if (firstRun) dispatch({ type: 'setView', view: 'chat' });
        }}
        onSaved={() => {
          setEditing(null);
          dispatch({ type: 'setView', view: 'chat' });
        }}
      />
    );
  }

  return (
    <div className="page">
      <header className="page__header">
        <button className="btn btn--ghost btn--icon" onClick={() => dispatch({ type: 'setView', view: 'chat' })} title="Back to chat" aria-label="Back to chat">
          <Icon name="arrowLeft" />
        </button>
        <h2>Providers</h2>
      </header>

      {settingsProblems.length > 0 && (
        <div className="banner banner--warn" role="alert">
          <Icon name="warning" />
          <div>
            <strong>Some settings were ignored</strong>
            <ul>
              {settingsProblems.map((p, i) => (
                <li key={i}>
                  <code>{p.setting}</code> {p.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <ul className="profile-list">
        {profiles.map((profile) => {
          const active = profile.id === activeProfileId;
          return (
            <li key={profile.id} className={`profile${active ? ' profile--active' : ''}`}>
              <button
                className="profile__main"
                onClick={() => post({ type: 'setActiveProfile', id: profile.id })}
                aria-pressed={active}
                title={active ? 'Active provider' : 'Use this provider'}
              >
                <span className={`radio${active ? ' radio--on' : ''}`} aria-hidden="true" />
                <span className="profile__text">
                  <span className="profile__name">
                    {profile.name}
                    {active && <span className="pill pill--accent">Active</span>}
                  </span>
                  <span className="profile__meta">{profile.model}</span>
                  <span className="profile__meta profile__meta--dim">{profile.baseUrl}</span>
                  {!profile.hasKey && (
                    <span className="profile__meta profile__meta--dim">
                      <Icon name="key" size={12} /> No API key stored
                    </span>
                  )}
                </span>
              </button>
              <div className="profile__actions">
                {confirmDelete === profile.id ? (
                  <>
                    <button
                      className="btn btn--danger btn--small"
                      onClick={() => {
                        post({ type: 'deleteProfile', id: profile.id });
                        setConfirmDelete(null);
                      }}
                    >
                      Delete
                    </button>
                    <button className="btn btn--secondary btn--small" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn btn--ghost btn--icon"
                      title="Edit"
                      aria-label={`Edit ${profile.name}`}
                      onClick={() =>
                        setEditing({ draft: toDraft(profile), presetId: '', apiKey: '', keyAction: profile.hasKey ? 'keep' : 'replace' })
                      }
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      className="btn btn--ghost btn--icon"
                      title="Delete"
                      aria-label={`Delete ${profile.name}`}
                      onClick={() => setConfirmDelete(profile.id)}
                    >
                      <Icon name="trash" />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <button
        className="btn btn--secondary btn--block"
        onClick={() => setEditing({ draft: emptyDraft(), presetId: '', apiKey: '', keyAction: 'replace' })}
      >
        <Icon name="plus" /> Add provider
      </button>

      <p className="hint hint--center">
        Keys are kept in VS Code secret storage.{' '}
        <button className="link" onClick={() => post({ type: 'openVsCodeSettings' })}>
          More settings
        </button>
      </p>
    </div>
  );
}

interface FormProps {
  initial: FormState;
  presets: PresetView[];
  existing: ProfileView | undefined;
  firstRun: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function ProfileForm({ initial, presets, existing, firstRun, onClose, onSaved }: FormProps) {
  const [draft, setDraft] = useState<ProfileDraft>(initial.draft);
  const [presetId, setPresetId] = useState(initial.presetId);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [keyAction, setKeyAction] = useState<KeyAction>(initial.keyAction);
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [saveId, setSaveId] = useState<string>();
  const [testId, setTestId] = useState<string>();
  const [modelsId, setModelsId] = useState<string>();
  const [localErrors, setLocalErrors] = useState<FieldProblem[]>([]);

  const saved = useReply(saveId, 'profileSaved');
  const tested = useReply(testId, 'connectionResult');
  const models = useReply(modelsId, 'models');

  const isNew = !existing;
  const preset = presets.find((p) => p.id === presetId);
  const needsKey = preset ? preset.needsKey : true;
  const saving = Boolean(saveId) && !saved;
  const testing = Boolean(testId) && !tested;
  const loadingModels = Boolean(modelsId) && !models;

  useEffect(() => {
    if (saved?.ok) onSaved();
  }, [saved, onSaved]);

  const errors = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of [...(tested?.errors ?? []), ...(saved?.errors ?? []), ...localErrors]) map.set(e.field, e.message);
    return map;
  }, [saved, tested, localErrors]);

  const warnings = saved?.warnings ?? [];

  const set = (patch: Partial<ProfileDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setLocalErrors([]);
  };

  const choosePreset = (p: PresetView): void => {
    setPresetId(p.id);
    setDraft((d) => ({
      ...d,
      name: p.id === 'custom' ? d.name : p.name.replace(/\s*\(local\)$/, ''),
      baseUrl: p.baseUrl || d.baseUrl,
    }));
    setTestId(undefined);
    setModelsId(undefined);
  };

  const keyToSend = (): string | null | undefined => {
    if (keyAction === 'remove') return null;
    if (keyAction === 'replace') return apiKey.trim() ? apiKey.trim() : isNew ? undefined : undefined;
    return undefined;
  };

  const validateLocal = (requireModel: boolean): boolean => {
    const problems: FieldProblem[] = [];
    if (!draft.baseUrl.trim()) problems.push({ field: 'baseUrl', message: 'Enter the base URL of your provider.' });
    if (requireModel && !draft.model.trim()) problems.push({ field: 'model', message: 'Enter a model name.' });
    setLocalErrors(problems);
    return problems.length === 0;
  };

  const save = (): void => {
    const name = draft.name.trim() || preset?.name || 'My provider';
    if (!validateLocal(true)) return;
    const id = requestId();
    setSaveId(id);
    post({ type: 'saveProfile', requestId: id, draft: { ...draft, name }, apiKey: keyToSend(), makeActive: true });
  };

  const test = (): void => {
    if (!validateLocal(true)) return;
    const id = requestId();
    setTestId(id);
    post({ type: 'testConnection', requestId: id, draft: { ...draft, name: draft.name || 'test' }, apiKey: keyToSend() });
  };

  const loadModels = (): void => {
    if (!validateLocal(false)) return;
    const id = requestId();
    setModelsId(id);
    post({ type: 'listModels', requestId: id, draft: { ...draft, name: draft.name || 'test', model: draft.model || 'x' }, apiKey: keyToSend() });
  };

  const showPresets = isNew;
  const showFields = !isNew || Boolean(presetId);

  return (
    <div className="page">
      <header className="page__header">
        {!firstRun && (
          <button className="btn btn--ghost btn--icon" onClick={onClose} title="Back" aria-label="Back">
            <Icon name="arrowLeft" />
          </button>
        )}
        <h2>{firstRun ? 'Connect a provider' : isNew ? 'Add provider' : `Edit ${existing?.name ?? ''}`}</h2>
      </header>

      {firstRun && (
        <p className="lead">
          ByteAgent works with any OpenAI-compatible API. Pick one to get started; you can add more later.
        </p>
      )}

      {showPresets && (
        <div className="preset-grid" role="radiogroup" aria-label="Provider">
          {presets.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={presetId === p.id}
              className={`preset${presetId === p.id ? ' preset--on' : ''}`}
              onClick={() => choosePreset(p)}
            >
              <Icon name={p.id === 'custom' ? 'plug' : p.needsKey ? 'sparkle' : 'terminal'} />
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      )}

      {showFields && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label="Name" error={errors.get('name')}>
            <input
              className="input"
              value={draft.name}
              placeholder={preset?.name ?? 'My provider'}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>

          <Field label="Base URL" error={errors.get('baseUrl')} hint="The address of the API, usually ending in /v1">
            <input
              className="input input--mono"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
          </Field>

          <Field
            label={needsKey ? 'API key' : 'API key (optional)'}
            hint={
              existing?.hasKey && keyAction === 'keep'
                ? undefined
                : needsKey
                  ? 'Stored securely on this computer. Never written to settings or logs.'
                  : 'Local servers usually need no key.'
            }
            action={
              preset?.keyHelpUrl ? (
                <button type="button" className="link" onClick={() => post({ type: 'openExternal', url: preset.keyHelpUrl as string })}>
                  Get a key <Icon name="external" size={11} />
                </button>
              ) : undefined
            }
          >
            {existing?.hasKey && keyAction === 'keep' ? (
              <div className="key-saved">
                <span className="key-saved__label">
                  <Icon name="check" /> Key saved
                </span>
                <button type="button" className="btn btn--secondary btn--small" onClick={() => setKeyAction('replace')}>
                  Replace
                </button>
                <button type="button" className="btn btn--secondary btn--small" onClick={() => setKeyAction('remove')}>
                  Remove
                </button>
              </div>
            ) : keyAction === 'remove' ? (
              <div className="key-saved">
                <span className="key-saved__label key-saved__label--warn">The key will be removed when you save</span>
                <button type="button" className="btn btn--secondary btn--small" onClick={() => setKeyAction('keep')}>
                  Undo
                </button>
              </div>
            ) : (
              <div className="input-group">
                <input
                  className="input input--mono"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  placeholder={needsKey ? 'Paste your key' : 'Leave empty if not needed'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--icon input-group__btn"
                  onClick={() => setShowKey((v) => !v)}
                  title={showKey ? 'Hide key' : 'Show key'}
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                >
                  <Icon name={showKey ? 'eyeOff' : 'eye'} />
                </button>
              </div>
            )}
          </Field>

          <Field
            label="Model"
            error={errors.get('model')}
            action={
              <button type="button" className="link" onClick={loadModels} disabled={loadingModels}>
                {loadingModels ? <Spinner size={11} /> : <Icon name="refresh" size={11} />} Load models
              </button>
            }
          >
            <input
              className="input input--mono"
              value={draft.model}
              placeholder={preset?.modelHint ?? 'Model name'}
              spellCheck={false}
              list="byteagent-models"
              onChange={(e) => set({ model: e.target.value })}
            />
            <datalist id="byteagent-models">
              {(models?.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {models && !models.error && models.models.length > 0 && (
              <div className="model-chips">
                {models.models.slice(0, 40).map((m) => (
                  <button
                    type="button"
                    key={m}
                    className={`chip chip--button${draft.model === m ? ' chip--on' : ''}`}
                    onClick={() => set({ model: m })}
                  >
                    {m}
                  </button>
                ))}
                {models.models.length > 40 && <span className="hint">and {models.models.length - 40} more: type to search</span>}
              </div>
            )}
            {models?.error && <p className="field__error">{models.error}</p>}
            {models && !models.error && models.models.length === 0 && (
              <p className="hint">This endpoint did not list any models. Type the model name.</p>
            )}
          </Field>

          <button type="button" className="disclosure" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
            <Icon name={advanced ? 'chevronDown' : 'chevronRight'} /> Advanced
          </button>

          {advanced && (
            <div className="form__grid">
              <Field label="Temperature" error={errors.get('temperature')} hint="0 to 2. Empty uses the provider default.">
                <input className="input" inputMode="decimal" value={String(draft.temperature ?? '')} onChange={(e) => set({ temperature: e.target.value })} />
              </Field>
              <Field label="Max output tokens" error={errors.get('maxOutputTokens')}>
                <input className="input" inputMode="numeric" value={String(draft.maxOutputTokens ?? '')} onChange={(e) => set({ maxOutputTokens: e.target.value })} />
              </Field>
              <Field label="Context window" error={errors.get('contextWindow')} hint="Tokens the model can read at once.">
                <input className="input" inputMode="numeric" value={String(draft.contextWindow ?? '')} onChange={(e) => set({ contextWindow: e.target.value })} />
              </Field>
              <Field label="Timeout (seconds)" error={errors.get('timeoutSeconds')}>
                <input className="input" inputMode="numeric" value={String(draft.timeoutSeconds ?? '')} placeholder="60" onChange={(e) => set({ timeoutSeconds: e.target.value })} />
              </Field>
              <Field label="Tool calling" hint="Auto tries the provider's tool support and falls back to text.">
                <select className="input" value={draft.toolCalling ?? 'auto'} onChange={(e) => set({ toolCalling: e.target.value as ProfileDraft['toolCalling'] })}>
                  <option value="auto">Auto</option>
                  <option value="native">Native</option>
                  <option value="text">Text</option>
                </select>
              </Field>
            </div>
          )}

          {warnings.map((w, i) => (
            <div key={i} className="banner banner--warn">
              <Icon name="warning" /> <span>{w.message}</span>
            </div>
          ))}

          {tested && (
            <div className={`banner ${tested.ok ? 'banner--ok' : 'banner--error'}`} role="status">
              <Icon name={tested.ok ? 'check' : 'error'} />
              <span>
                {tested.message}
                {tested.ok && tested.latencyMs !== undefined && <span className="hint"> · {tested.latencyMs} ms</span>}
              </span>
            </div>
          )}

          <div className="form__actions">
            <button type="button" className="btn btn--secondary" onClick={test} disabled={testing || saving}>
              {testing ? <Spinner /> : <Icon name="plug" />} Test connection
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? <Spinner /> : null} {isNew ? 'Save and start' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Field(props: { label: string; hint?: string; error?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className={`field${props.error ? ' field--error' : ''}`}>
      <span className="field__top">
        <span className="field__label">{props.label}</span>
        {props.action && <span className="field__action" onClick={(e) => e.preventDefault()}>{props.action}</span>}
      </span>
      {props.children}
      {props.error ? <span className="field__error">{props.error}</span> : props.hint ? <span className="hint">{props.hint}</span> : null}
    </label>
  );
}
