import type { AppState, ChatItem, HostMessage, PresetView, ProfileView, WebviewMessage } from '../../../src/shared/protocol';

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

// ───────────────────────── chat scenarios ─────────────────────────


const answer = `The discount is applied **after** tax in \`src/services/pricing.ts:41\`, so a 10% coupon on a 100.00 order with 20% tax gives 108.00 instead of 108.00 − tax on the discount.

Two things need to change:

1. Apply the coupon to the subtotal before tax.
2. Round once, at the end.

\`\`\`ts
export function orderTotal(order: Order): number {
  const subtotal = sum(order.lines.map((l) => l.price * l.qty));
  const discounted = subtotal * (1 - order.couponRate);
  return roundCents(discounted * (1 + TAX_RATE));
}
\`\`\`

| Case | Before | After |
|---|---|---|
| 100.00, 10% coupon | 108.00 | 108.00 |
| 19.99 × 3, 15% coupon | 61.18 | 61.17 |

I'll update the function and its test.`;

const reviewItems: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'The order total is wrong when a coupon is used. Can you fix it and update the test?', attachments: [{ path: 'src/services/pricing.ts', startLine: 30, endLine: 52, source: 'selection' }], mode: 'auto' },
  { kind: 'classification', id: 'c1', mode: 'standard', auto: true, confidence: 0.72, reasons: ['Asks for a code change', 'Mentions tests, so more than one file is likely'] },
  {
    kind: 'context', id: 'x1', totalTokens: 2140, budget: 24000,
    files: [
      { path: 'src/services/pricing.ts', reason: 'your selection', tokens: 610, startLine: 30, endLine: 52 },
      { path: 'tests/services/pricing.test.ts', reason: 'test for pricing.ts', tokens: 880 },
      { path: 'src/models/order.ts', reason: 'matches "order", "coupon"', tokens: 650, truncated: true },
    ],
    omitted: [{ path: 'src/routes/orders.ts', reason: 'lower relevance' }, { path: '.env', reason: 'sensitive file' }],
  },
  { kind: 'tool', id: 't1', tool: 'search_files', title: 'Searched for "couponRate"', status: 'done', detail: '4 matches' },
  { kind: 'tool', id: 't2', tool: 'read_file', title: 'Read src/services/tax.ts', status: 'done', detail: '48 lines', path: 'src/services/tax.ts' },
  { kind: 'assistant', id: 'a1', text: answer, streaming: false },
  {
    kind: 'changes', id: 'ch1', changeSetId: 'cs1', status: 'pending',
    summary: 'Apply the coupon before tax and round once.',
    files: [
      { changeId: 'f1', path: 'src/services/pricing.ts', kind: 'modify', added: 4, removed: 6, status: 'pending' },
      { changeId: 'f2', path: 'tests/services/pricing.test.ts', kind: 'modify', added: 14, removed: 2, status: 'pending' },
      { changeId: 'f3', path: 'tests/services/fixtures/coupon-order.json', kind: 'create', added: 18, removed: 0, status: 'pending' },
    ],
  },
];

const doneItems: ChatItem[] = [
  ...reviewItems.slice(0, 6),
  {
    kind: 'changes', id: 'ch1', changeSetId: 'cs1', status: 'resolved',
    summary: 'Apply the coupon before tax and round once.',
    files: [
      { changeId: 'f1', path: 'src/services/pricing.ts', kind: 'modify', added: 4, removed: 6, status: 'applied' },
      { changeId: 'f2', path: 'tests/services/pricing.test.ts', kind: 'modify', added: 14, removed: 2, status: 'applied' },
      { changeId: 'f3', path: 'tests/services/fixtures/coupon-order.json', kind: 'create', added: 18, removed: 0, status: 'rejected' },
    ],
  },
  {
    kind: 'command', id: 'k1', requestId: 'q1', command: 'npm test -- pricing', purpose: 'Run the pricing tests to check the fix.', risk: 'safe', riskReasons: [],
    canRemember: true, remembered: false, status: 'done', verification: true, exitCode: 0, durationMs: 3420,
    output: ' ✓ tests/services/pricing.test.ts (7 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  7 passed (7)',
  },
  { kind: 'assistant', id: 'a2', text: 'The coupon is now applied before tax. The pricing tests pass (7 of 7). I left out the new fixture file as you asked; the test builds the order inline instead.', streaming: false },
  {
    kind: 'outcome', id: 'o1',
    outcome: {
      applied: ['src/services/pricing.ts', 'tests/services/pricing.test.ts'],
      rejected: ['tests/services/fixtures/coupon-order.json'],
      failed: [],
      commands: [{ command: 'npm test -- pricing', exitCode: 0, passed: true, verification: true }],
      diagnostics: { errors: 0, warnings: 0, files: [] },
      verification: 'passed',
      notes: [],
    },
  },
];

const commandItems: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'Clean the build output and reinstall dependencies', attachments: [], mode: 'auto' },
  { kind: 'classification', id: 'c1', mode: 'quick', auto: true, confidence: 0.8, reasons: ['Short request', 'No file edits expected'] },
  { kind: 'assistant', id: 'a1', text: 'I need to run two commands for this.', streaming: false },
  {
    kind: 'command', id: 'k1', requestId: 'q1', command: 'rm -rf dist node_modules && npm install', purpose: 'Remove build output and installed packages, then reinstall.', risk: 'destructive',
    riskReasons: ['Deletes files recursively (rm -rf)', 'Chains several commands'], canRemember: false, remembered: false, status: 'pending', verification: false,
  },
];

const planItems: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'Add token-based authentication across the API, with login, refresh and protected routes.', attachments: [], mode: 'auto' },
  { kind: 'classification', id: 'c1', mode: 'project', auto: true, confidence: 0.84, reasons: ['Cross-module feature (authentication)', 'Several deliverables: login, refresh, protected routes'] },
  {
    kind: 'plan', id: 'p1', taskId: 'task1', goal: 'Token-based authentication',
    criteria: ['POST /login returns access and refresh tokens', 'Protected routes reject requests without a valid token', 'Tests cover login, refresh and rejection'],
    steps: [
      { id: '1', title: 'Inspect existing user model and routes', status: 'done' },
      { id: '2', title: 'Add token service with sign and verify', status: 'done' },
      { id: '3', title: 'Add login and refresh endpoints', status: 'in_progress' },
      { id: '4', title: 'Protect order routes with middleware', status: 'pending' },
      { id: '5', title: 'Add tests and run the suite', status: 'pending' },
    ],
  },
  { kind: 'tool', id: 't1', tool: 'read_file', title: 'Read src/routes/index.ts', status: 'running', path: 'src/routes/index.ts' },
];

const errorItems: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'Explain what orders.ts does', attachments: [{ path: 'src/routes/orders.ts', source: 'active' }], mode: 'auto' },
  { kind: 'error', id: 'e1', message: 'The provider rejected the API key (401). Check the key in Provider Settings.', code: 'auth', canRetry: true, openSettings: true },
];

function chatRespond(message: WebviewMessage, state: AppState, send: (m: HostMessage) => void): AppState | void {
  if (message.type === 'searchFiles') {
    const all = ['src/routes/orders.ts', 'src/services/pricing.ts', 'src/services/tax.ts', 'src/models/order.ts', 'tests/services/pricing.test.ts', 'package.json'];
    send({ type: 'fileSuggestions', requestId: message.requestId, files: all.filter((f) => f.toLowerCase().includes(message.query.toLowerCase())) });
    return;
  }
  if (message.type === 'setMode') return { ...state, defaultMode: message.mode };
  if (message.type === 'sendPrompt') {
    const user: ChatItem = { kind: 'user', id: `u${Date.now()}`, text: message.text, attachments: message.attachments, mode: message.mode };
    const id = `a${Date.now()}`;
    window.setTimeout(() => {
      send({ type: 'itemAdded', sessionId: state.sessionId, item: user });
      send({ type: 'busy', sessionId: state.sessionId, busy: true });
      send({ type: 'itemAdded', sessionId: state.sessionId, item: { kind: 'assistant', id, text: '', streaming: true } });
      const words = answer.split(/(?<=\s)/);
      words.forEach((word, i) => window.setTimeout(() => send({ type: 'textDelta', sessionId: state.sessionId, id, delta: word }), 200 + i * 12));
      window.setTimeout(() => {
        send({ type: 'itemUpdated', sessionId: state.sessionId, id, patch: { streaming: false } });
        send({ type: 'busy', sessionId: state.sessionId, busy: false });
        send({ type: 'usage', sessionId: state.sessionId, usage: { inputTokens: 2310, outputTokens: 412, estimated: false } });
      }, 300 + words.length * 12);
    }, 30);
    return;
  }
  return settingsRespond(message, state, send);
}

Object.assign(scenarios, {
  empty: { state: baseState(), respond: chatRespond },
  review: { state: baseState({ items: reviewItems, busy: true, usage: { inputTokens: 3120, outputTokens: 540, estimated: false } }), respond: chatRespond },
  done: { state: baseState({ items: doneItems, usage: { inputTokens: 5210, outputTokens: 890, estimated: false } }), respond: chatRespond },
  command: { state: baseState({ items: commandItems, busy: true }), respond: chatRespond },
  plan: { state: baseState({ items: planItems, busy: true, defaultMode: 'project' }), respond: chatRespond },
  error: { state: baseState({ items: errorItems }), respond: chatRespond },
  history: {
    state: baseState({
      sessions: [
        { id: 's1', title: 'The order total is wrong when a coupon is used', updatedAt: Date.now() - 120000, messageCount: 3 },
        { id: 's2', title: 'Explain what orders.ts does', updatedAt: Date.now() - 7200000, messageCount: 1 },
        { id: 's3', title: 'Add pagination to the product list endpoint', updatedAt: Date.now() - 86400000 * 2, messageCount: 6 },
      ],
      tasks: [{ id: 't1', title: 'Token-based authentication', mode: 'project', status: 'in_progress', updatedAt: Date.now() - 3600000, stepsDone: 2, stepsTotal: 5 }],
    }),
    respond: chatRespond,
  },
} satisfies Record<string, Scenario>);
