// Browser harness: runs the real UI against a scripted fake extension host.
import type { AppState, HostMessage, WebviewMessage } from '../../../src/shared/protocol';
import { scenarios } from './scenarios';
import './theme.css';

const params = new URLSearchParams(window.location.hash.slice(1));
// VS Code sets theme variables on <html> and the theme class on <body>.
const themeClass = params.get('theme') === 'light' ? 'vscode-light' : 'vscode-dark';
document.documentElement.className = themeClass;
document.body.className = themeClass;
const width = params.get('width');
if (width) document.documentElement.style.setProperty('--harness-width', `${width}px`);

const scenario = scenarios[params.get('scenario') ?? 'empty'] ?? scenarios.empty!;
let state: AppState = scenario.state;

function send(message: HostMessage): void {
  window.postMessage(message, '*');
}

const sent: WebviewMessage[] = [];
(window as unknown as { __sent: WebviewMessage[] }).__sent = sent;

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage(message: WebviewMessage) {
    sent.push(message);
    if (message.type === 'ready') {
      send({ type: 'state', state });
      scenario.after?.(send);
      return;
    }
    const next = scenario.respond?.(message, state, send);
    if (next) {
      state = next;
      send({ type: 'state', state });
    }
  },
  getState: () => ({ view: params.get('view') ?? 'chat', draft: params.get('draft') ?? '' }),
  setState: () => undefined,
});

void import('../main').then(async () => {
  // Scripted interactions: click=<selector>|<selector> and type=<selector>=<text>
  const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
  await wait(150);
  for (const selector of (params.get('click') ?? '').split('|').filter(Boolean)) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) el.click();
    else console.warn(`harness: nothing matches ${selector}`);
    await wait(450);
  }
});
