import type { HostMessage, WebviewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

function getApi(): VsCodeApi {
  if (!api) api = acquireVsCodeApi();
  return api;
}

export function post(message: WebviewMessage): void {
  getApi().postMessage(message);
}

export function onHostMessage(handler: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent): void => {
    const data = event.data as HostMessage | undefined;
    if (data && typeof data === 'object' && typeof data.type === 'string') handler(data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** Small per-webview persisted UI state (draft text, current view). */
export function loadUiState<T>(fallback: T): T {
  const stored = getApi().getState();
  return stored && typeof stored === 'object' ? { ...fallback, ...(stored as Partial<T>) } : fallback;
}

export function saveUiState(state: unknown): void {
  getApi().setState(state);
}

let counter = 0;
export function requestId(): string {
  counter += 1;
  return `r${Date.now().toString(36)}${counter}`;
}
