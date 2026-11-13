# ByteAgent Architecture

This document describes module responsibilities and the allowed dependency
direction. It is the reference for where new code belongs.

## 1. Two processes

ByteAgent runs as two cooperating parts:

| Part | Runs in | Built with | Entry |
|---|---|---|---|
| Extension host | VS Code's Node.js extension host | TypeScript, bundled by esbuild | `src/extension.ts` → `dist/extension.js` |
| Chat UI | A sandboxed VS Code webview in the sidebar | React, bundled by Vite | `webview/src/main.tsx` → `dist/webview/` |

They communicate only through typed messages defined in
`src/shared/protocol.ts`. The webview never touches the file system, the
network, or secrets. It renders state and sends user intent.

## 2. Core rule: the core does not import `vscode`

Everything that decides *what the agent does* is plain TypeScript that runs
in Node.js without VS Code. Only thin adapter files import the `vscode`
module. This keeps the agent testable with Vitest and keeps the door open
for another client later.

Files allowed to import `vscode`:

- `src/extension.ts`
- `src/commands/*`
- `src/chat/*` (webview provider, VS Code host adapter)
- `src/shared/vscodeLogger.ts`, `src/config/vscodeSettings.ts`,
  `src/config/secrets.ts`
- `src/changes/vscodeReview.ts`

A unit test (`tests/unit/boundaries.test.ts`) fails the build if any other
file imports `vscode`, or if `src/agent` imports a vendor SDK.

## 3. Modules

```text
src/
├── extension.ts     activation, wiring
├── commands/        VS Code command registrations
├── chat/            webview provider, chat controller, VS Code host adapter
├── config/          settings model, validation, SecretStorage wrapper
├── providers/       provider contract and the OpenAI-compatible adapter
├── agent/           classifier, prompts, runtime loop, task state
├── context/         workspace scan, exclusions, search, ranking, budget
├── tools/           tool registry, permissions, command runner, built-in tools
├── changes/         proposed changes, validation, apply, diff summaries
├── project/         SQLite store, onboarding, document sync, resume
└── shared/          errors, redaction, hashing, token estimates, protocol
```

### Responsibilities

| Module | Owns | Must not own |
|---|---|---|
| `providers` | HTTP protocol, streaming parse, capability flags, provider error mapping | Project memory, task state, tool execution, policy |
| `agent` | Task classification, the tool-calling loop, escalation, task state transitions | HTTP details, file system access, UI |
| `context` | Which files exist, which are excluded, search, ranking, token budget | Deciding to apply changes |
| `tools` | Tool definitions, argument validation, permission checks, command execution | Model communication |
| `changes` | Normalised change proposals, path validation, stale-hash checks, application | Approval UI |
| `project` | Persistent structured state and generated documents | Live chat rendering |
| `chat` | Bridging the webview and the runtime, approvals shown to the user | Agent decisions |
| `shared` | Small dependency-free helpers | Anything stateful |

## 4. Dependency direction

```text
extension.ts ─► commands ─► chat ─► agent ─► tools ─► changes
                              │       │        │         │
                              │       ├────────┴─► context
                              │       ├─► providers
                              │       └─► project
                              └─► config
                 every module ─► shared
```

Rules:

- `shared` imports nothing from other modules.
- `providers` imports only `shared`.
- `context` and `changes` import only `shared`.
- `tools` may import `context`, `changes` and `shared`.
- `agent` may import `providers` (types and interface only), `tools`,
  `context`, `changes`, `project` and `shared`.
- Nothing imports `chat`, `commands` or `extension.ts`.

## 5. The agent host interface

The runtime never talks to the user directly. It calls an `AgentHost`
interface (`src/agent/host.ts`) for everything that needs a human or the
editor:

- `reviewChanges(changeSet)` → accepted, rejected or revise per file
- `approveCommand(request)` → allow once, allow always, or deny
- `confirmContext(summary)` → optional pre-send confirmation
- `getDiagnostics(paths)` → editor diagnostics for verification
- `emit(event)` → progress events for the UI

The VS Code implementation lives in `src/chat/`. Tests use a scripted fake
host. Because approval is a required return value of the host call, there is
no code path that applies a change or runs a command without it.

## 6. Request lifecycle

1. The user sends a prompt from the webview.
2. `chat` builds an `AgentRequest` (prompt, mentions, editor selection).
3. `agent/classifier` returns a `TaskClassification` (Quick, Standard or
   Project) with reasons.
4. `context` builds a context package inside the token budget and records
   what was omitted.
5. `agent/runtime` streams from the provider and executes tool calls through
   the `tools` registry.
6. File edits become a `ChangeSet`. The host shows the diff. Only accepted
   files are applied, and only if their base hash still matches.
7. Verification runs through approved commands and editor diagnostics.
   Results are stored as evidence.
8. The runtime produces an outcome summary built from recorded facts, not
   from the model's own claims.

## 7. Persistence

| Data | Location | Introduced |
|---|---|---|
| Provider profiles | VS Code settings (`byteagent.*`) | M1 |
| API keys | VS Code SecretStorage | M1 |
| Chat sessions | VS Code `workspaceState` | M2 |
| Remembered safe commands | VS Code `workspaceState` | M5 |
| Tasks, steps, events, verification, file index, symbols | `.byteagent/agent.db` (SQLite) | M7 |
| Human-readable project documents | `.byteagent/*.md` | M7 |

The SQLite store is the source of truth for task state. Markdown documents
under `.byteagent/` are generated from it.

## 8. Testing layout

| Folder | Runner | Scope |
|---|---|---|
| `tests/unit/` | Vitest | Pure logic, one module at a time |
| `tests/integration/` | Vitest | Runtime + mock provider server + temp workspace on disk |
| `tests/extension/` | VS Code Extension Test API | Activation, commands, settings, secrets, end-to-end in a real host |
| `tests/mock/` | — | The mock OpenAI-compatible server used by the above |
