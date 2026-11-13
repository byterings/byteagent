import type { AppState, HostMessage, PresetView, ProfileView, WebviewMessage } from '../../../src/shared/protocol';

export interface Scenario {
  state: AppState;
  after?: (send: (m: HostMessage) => void) => void;
  respond?: (message: WebviewMessage, state: AppState, send: (m: HostMessage) => void) => AppState | void;
}

const presets: PresetView[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, modelHint: 'Model name from your OpenAI account', keyHelpUrl: 'https://platform.openai.com/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, modelHint: 'vendor/model-name' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, modelHint: 'Model name' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, modelHint: 'Model name' },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false, modelHint: 'A model you have pulled locally' },
  { id: 'lmstudio', name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false, modelHint: 'The model loaded in LM Studio' },
  { id: 'custom', name: 'Custom endpoint', baseUrl: '', needsKey: true, modelHint: 'Model name' },
];

export const profiles: ProfileView[] = [
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'vendor/fast-coder-large', hasKey: true, contextWindow: 128000 },
  { id: 'local', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'coder:14b', hasKey: false },
];

export function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    ready: true,
    hasWorkspace: true,
    workspaceName: 'shop-api',
    profiles,
    activeProfileId: 'openrouter',
    presets,
    settingsProblems: [],
    defaultMode: 'auto',
    sessions: [],
    sessionId: 's1',
    items: [],
    busy: false,
    usage: null,
    tasks: [],
    projectInitialized: false,
    editor: { activeFile: 'src/routes/orders.ts' },
    ...overrides,
  };
}

function settingsRespond(message: WebviewMessage, state: AppState, send: (m: HostMessage) => void): AppState | void {
  if (message.type === 'testConnection') {
    window.setTimeout(() => send({ type: 'connectionResult', requestId: message.requestId, ok: true, message: 'Connected. The model replied.', latencyMs: 412 }), 300);
  }
  if (message.type === 'listModels') {
    window.setTimeout(() => send({ type: 'models', requestId: message.requestId, models: ['vendor/fast-coder-large', 'vendor/fast-coder-small', 'vendor/reasoner-xl', 'other/open-model-70b'] }), 300);
  }
  if (message.type === 'saveProfile') {
    send({ type: 'profileSaved', requestId: message.requestId, ok: true, errors: [], warnings: [], profileId: 'new' });
    return { ...state, profiles: [...state.profiles, { ...(message.draft as unknown as ProfileView), id: 'new', hasKey: true }], activeProfileId: 'new' };
  }
  if (message.type === 'setActiveProfile') return { ...state, activeProfileId: message.id };
  if (message.type === 'deleteProfile') return { ...state, profiles: state.profiles.filter((p) => p.id !== message.id) };
}

export const scenarios: Record<string, Scenario> = {
  empty: { state: baseState(), respond: settingsRespond },
  firstRun: { state: baseState({ profiles: [], activeProfileId: '' }), respond: settingsRespond },
  settings: {
    state: baseState({
      settingsProblems: [{ setting: 'byteagent.providers[2]', message: 'baseUrl: That is not a valid URL.' }],
    }),
    respond: settingsRespond,
  },
};
