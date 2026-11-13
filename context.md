# Project Context

## Overview
ByteAgent is a provider-agnostic AI coding agent delivered as a Visual
Studio Code extension. The user connects any OpenAI-compatible endpoint
with their own API key. ByteAgent owns project discovery, context
selection, task execution, change review, verification and persistent
project state. It is free to use and proprietary.

Detailed references:
- `docs/architecture.md`: modules and dependency rules
- `docs/provider-contract.md`: provider interface and error model
- `docs/security.md`: secrets, exclusions, change and command policy
- `docs/decisions.md`: confirmed decisions

## Architecture
- Backend: none. Everything runs locally inside the VS Code extension
  host (Node.js, TypeScript, bundled with esbuild).
- Frontend: a React chat UI in a sidebar webview (bundled with Vite),
  talking to the extension host through typed messages.
- Database: SQLite through WebAssembly (`sql.js`) at
  `.byteagent/agent.db` inside the user's workspace, planned for
  Milestone 7. VS Code settings, SecretStorage and `workspaceState` hold
  configuration, keys and chat sessions.

## Modules
Planned layout under `src/` (see `project_status.md` for what exists):
- `providers`: provider contract and OpenAI-compatible adapter
- `agent`: classifier, prompts, runtime loop, task state
- `context`: scan, exclusions, search, ranking, token budget
- `tools`: registry, permissions, command runner, built-in tools
- `changes`: change proposals, validation, application
- `project`: SQLite store, onboarding, document sync, resume
- `chat`, `commands`, `config`: VS Code adapters
- `shared`: errors, redaction, hashing, token estimates, protocol
- `webview/`: React chat UI

## Data Flow
1. The user sends a prompt in the chat view.
2. The classifier picks Quick, Standard or Project mode.
3. The context engine selects relevant files within a token budget.
4. The runtime streams from the provider and runs tool calls through the
   tool registry.
5. Edits become a change set that the user reviews as a diff. Only
   accepted, non-stale changes are applied.
6. Commands run only after separate approval. Results are stored as
   verification evidence.
7. The user sees a summary built from recorded facts.

## Integrations
- APIs: any OpenAI-compatible `chat/completions` endpoint chosen by the
  user. No ByteAgent-operated service exists.
- Services: VS Code Extension API, Git CLI, ripgrep when available.

## Constraints
- Core logic must not import `vscode` or any vendor SDK.
- No file change without explicit approval; no command without separate
  approval.
- The whole repository is never sent by default.
- Status claims must be backed by recorded evidence.
- Local `file:` workspaces only for now.
- Automated tests use a mock provider; real-provider behaviour is
  unverified until tested with a live key.
