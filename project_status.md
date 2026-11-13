# Project Status

Actual implementation state, based on what exists in the repository and
what was verified by running it.

## Current State
Milestones 0 to 2 are complete. The extension builds, activates, stores
provider profiles and API keys, and holds a streamed chat with an
OpenAI-compatible endpoint. It cannot read project files or propose
changes yet. Development happens on the `dev` branch.

Environment used for development: Node 20.19.5, npm 10.8.2, VS Code
1.142.0, git 2.43.0, ripgrep 14.1.1, Linux.

---

## Completed

### R-000 Repository audit and technical design
- Status: done

Audit findings:
- The repository held six Markdown files and no code, manifest, tests or
  Git history.
- `context.md`, `project_status.md` and `roadmap.md` were unfilled
  templates.

Files Changed:
- docs/architecture.md (new)
- docs/provider-contract.md (new)
- docs/security.md (new)
- docs/decisions.md (new)
- roadmap.md, context.md, project_status.md (templates replaced)
- .gitignore (new)

What Changed:
- Defined module boundaries, the provider contract, the security model
  and thirteen recorded decisions.
- Mapped roadmap IDs R-000 to R-008 to the plan's milestones.

Why:
- Milestone 0 exit criteria: first vertical slice defined, provider
  boundaries and change-review policy documented.

Verification:
- Documents only. Nothing to execute.

### R-001 VS Code extension foundation
- Status: done

Files Changed:
- package.json, tsconfig.json, vitest.config.mts, scripts/build.mjs,
  scripts/shot.mjs, .vscodeignore, .vscode/
- src/extension.ts, src/commands/index.ts
- src/chat/ (services, controller, chatViewProvider, webviewHtml)
- src/config/ (settings, profileManager, secrets, vscodeSettings)
- src/shared/ (errors, redact, logger, vscodeLogger, hash, protocol)
- webview/ (React app shell, provider settings screen, styles, harness)
- media/ (activity bar icon, extension icon)
- tests/unit/, tests/extension/, tests/fixtures/

What Changed:
- Extension skeleton with an activity-bar chat view and ten commands.
- Validated settings with multiple provider profiles; invalid values are
  reported and ignored instead of crashing.
- API keys stored only in VS Code SecretStorage; the webview never
  receives a key.
- Redacting logger writing to the "ByteAgent" output channel.
- Provider settings UI with presets, key handling and field validation.

Why:
- Milestone 1 exit criteria.

Verification (2026-11-13):
- `npm run typecheck`: no errors.
- `npm test`: 4 files, 49 tests passed.
- `npm run test:extension` (real VS Code 1.142.0): 6 tests passed,
  covering activation, command registration, configuration validation,
  SecretStorage round trip, and profile save through the webview protocol.
- Settings screen checked visually in headless Chrome through the UI
  harness, dark and light themes.

### R-002 Provider contract and streaming chat
- Status: done

Files Changed:
- src/providers/ (types, sse, openaiCompatible, factory)
- src/agent/ (host, prompts, runtime)
- src/chat/ (controller, sessionStore), src/commands/index.ts
- src/config/secrets.ts, src/shared/tokens.ts
- webview/src/ (ChatView, HistoryView, Composer, Items, markdown,
  harness scenarios)
- tests/mock/mockServer.ts, tests/unit/, tests/integration/,
  tests/extension/chat.test.ts

What Changed:
- Provider-neutral contract and an OpenAI-compatible streaming adapter:
  tool-call assembly, first-byte and idle timeouts, cancellation, bounded
  retries, error mapping, parameter fallbacks, model listing.
- Chat runtime with conversation history, stop, retry and usage display.
- Chat sessions saved per workspace, with history.
- Chat UI: streamed Markdown with highlighted code, composer with mode
  and model menus, and the cards used by later milestones.
- Secret reads now see the extension's own recent writes, because VS Code
  secret storage returned a deleted key for a short time afterwards.

Why:
- Milestone 2 exit criteria.

Verification (2026-11-13):
- `npm run typecheck`: no errors.
- `npm test`: 8 files, 111 tests passed. Provider tests run against the
  local mock server and cover streaming, fragmented tool calls, malformed
  and empty streams, HTTP error mapping, retries, timeouts, cancellation
  and key redaction.
- `npm run test:extension`: 13 tests passed in VS Code 1.142.0, including
  prompt to streamed reply, stop, retry, connection test and model list.
- Chat screens checked visually through the UI harness.

Not verified:
- No request has been sent to a real provider. Behaviour against real
  endpoints, including the `max_completion_tokens` and temperature
  fallbacks, is untested.
- The webview was exercised through its message protocol and the browser
  harness, not by clicking inside VS Code.
- Two commands (project setup, add selection) respond with a "not
  available yet" message until their milestones.

---

## In Progress
- R-003 Workspace discovery and context v1

---

## Pending
- R-004 Safe patch proposals and diff review
- R-005 Tool manager and verification
- R-006 Adaptive execution policy
- R-007 Persistent project knowledge and onboarding
- R-008 Indexing improvements (light)

---

## Blockers
None
