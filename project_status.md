# Project Status

Actual implementation state, based on what exists in the repository and
what was verified by running it.

## Current State
Milestones 0 to 7 and the light Milestone 8 items are complete and
packaged as `byteagent.vsix`. ByteAgent chats with an OpenAI-compatible
endpoint, classifies each request, sends a budgeted set of relevant
files, reads and searches through tools, shows every file change for
review, runs commands only after separate approval, summarises each run
from recorded results, keeps tasks and evidence in a local SQLite
database, sets up project knowledge after review, and resumes unfinished
tasks after a restart or a provider switch.

It has been tested only against a scripted mock provider. The first run
with a real API key is still to be done. Development happens on the
`dev` branch.

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
- One command (project setup) responds with a "not available yet"
  message until its milestone.

### R-003 Workspace discovery and context v1
- Status: done

Files Changed:
- src/context/ (paths, ignore, workspaceIndex, search, techDetect,
  ranker, contextBuilder)
- src/chat/workspaceService.ts, src/chat/controller.ts,
  src/chat/services.ts, src/commands/index.ts
- src/agent/runtime.ts, src/agent/host.ts
- tests/helpers/tempWorkspace.ts, tests/unit/ (ignore, workspaceIndex,
  search, context), tests/integration/contextRuntime.test.ts,
  tests/extension/context.test.ts

What Changed:
- Exclusion policy: `.gitignore` (root and nested, with negation),
  settings exclusions, dependency folders and built-in sensitive-file
  rules. One policy serves scanning, search, reads and suggestions.
- Workspace index: scan with limits, safe path resolution (no `..`, no
  outside paths, no escaping symlinks), binary and size checks, content
  hashes, cache revalidated on every read, unsaved editor text preferred.
- Search through ripgrep when available with an in-process fallback;
  both return only indexed files.
- Technology detection from manifests.
- Relevance ranking with recorded reasons, and a context package bound
  by a token budget that lists what was left out and why.
- Chat shows the files sent with each request, supports `@` file
  mentions, the current file or selection, and optional confirmation
  before sending.

Why:
- Milestone 3 exit criteria.

Verification (2026-11-13):
- `npm run typecheck`: no errors.
- `npm test`: 13 files, 185 tests passed. Covered: exclusions, path
  escapes, symlinks, size and binary handling, cache invalidation on file
  change, both search engines returning nothing from blocked files,
  ranking, truncation, token budgeting, blocked attachments reported.
- `npm run test:extension`: 19 tests passed, including unsaved editor
  text used as context, `.env` never offered or sent, and confirmation
  before send.

Not verified:
- Token counts are estimates (deliberately high), not a real tokenizer.
- Ranking quality was checked on small fixture projects only, not on a
  large real repository.
- Multi-root workspaces: only the first folder is used.

### R-004 Safe patch proposals and diff review
- Status: done

Files Changed:
- src/changes/ (types, proposal, applier, vscodeReview)
- src/tools/ (schema, types, registry, index, builtin/readTools,
  builtin/proposeChanges)
- src/agent/ (runtime rewritten with the tool loop, textTools, host)
- src/chat/ (controller, vscodeChangeIO)
- webview/src/components/Items.tsx
- tests/unit/ (changes, tools), tests/integration/agentTools.test.ts,
  tests/extension/changes.test.ts

What Changed:
- The model changes files only through `propose_changes` (whole-file
  write, exact search-and-replace edit, delete). Proposals are normalised
  to full new content with a hash of the content they were based on.
- A proposal with any invalid part (path outside the workspace, blocked
  file, search text not found or ambiguous, no effective change) is
  returned to the model and never shown to the user.
- Review card with per-file accept and reject, "ask for changes", and the
  VS Code diff editor. Deletions start unselected and go to the trash
  where the platform supports it.
- At accept time each file is re-checked against the exclusion rules and
  its base hash, including unsaved editor text. Changed files are
  reported as stale and left alone. Written content is read back and
  compared. Results are reported per file.
- Tool registry with schema validation and permission classes, plus
  `read_file`, `search_files` and `list_directory`.
- Text-based tool protocol for endpoints without native tool calling,
  chosen by setting or automatically when the endpoint rejects tools.
- Step limit per run and removal of old tool output when the context
  window fills.

Why:
- Milestone 4 exit criteria. The tool registry was brought forward from
  Milestone 5 because the model needs a tool to propose changes.

Verification (2026-11-13):
- `npm run typecheck`: no errors.
- `npm test`: 16 files, 245 tests passed. Covered: accept, reject,
  mixed review, revision feedback, stale file on disk, stale unsaved
  editor text, file appearing at a new path, invalid and blocked paths,
  partial write failure, content mismatch after write, stop during
  review, text fallback.
- `npm run test:extension`: 31 tests passed in VS Code 1.142.0,
  including nothing written while a proposal waits, apply on accept,
  unchanged on reject, stale detection against unsaved editor changes,
  multi-file create/modify/delete, and the diff editor opening.

Not verified:
- Files are read and written as UTF-8. Files in other encodings are not
  handled specially and have not been tested.
- The review card's buttons were exercised through the webview message
  protocol and the browser harness, not by clicking inside VS Code.
- Trash behaviour for deletions was checked on Linux only.

### R-005 Tool manager and verification
- Status: done

Files Changed:
- src/tools/ (commandRisk, commandRunner, builtin/gitTools,
  builtin/runCommand, index, types)
- src/agent/ (outcome, runtime, host)
- src/chat/controller.ts, src/commands/index.ts, package.json
- tests/unit/ (commandRisk, commandRunner), tests/integration/
  commands.test.ts, tests/extension/commands.test.ts

What Changed:
- Tools: `git_status`, `git_diff` (read-only, fixed arguments, sensitive
  files removed from diffs) and `run_command`.
- Command risk classifier with three levels and reasons. Unknown
  commands are never "safe". Chains take the highest risk of their parts.
  Commands that touch sensitive files are flagged.
- Every command asks first. "Always allow" is stored per workspace and
  only for an exact, safe, unchained command. A new command,
  "ByteAgent: Forget Always-Allowed Commands", clears the list.
- Approving a file change never approves a command.
- Runner: workspace root, time limit, cancellation that kills the whole
  process group, bounded and redacted output, no terminal attached.
- Outcome card built only from recorded results: files applied, rejected
  or failed, commands with exit codes, editor diagnostics, and a
  verification state. "Verified" requires a check that exited with 0
  after the last file change.

Why:
- Milestone 5 exit criteria.

Verification (2026-11-13):
- `npm run typecheck`: no errors.
- `npm test`: 19 files, 388 tests passed, including 111 command
  classification cases, timeout and cancel killing child processes,
  denied commands not running, "always" refused for risky commands, and
  outcome states (passed, failed, not verified after a later change).
- `npm run test:extension`: 39 tests passed in VS Code 1.142.0,
  including a real `npm test` run in the fixture workspace after
  approval, remembered commands, and stop cancelling a running command.

Not verified:
- The command runner was tested on Linux only. Windows process-tree
  termination uses `taskkill` and is untested.
- The risk classifier is a rule list. Commands it does not know are
  treated as "moderate", but an unusual destructive command could be
  rated lower than it deserves; the user still sees and approves every
  command that is not on their own allow list.
- Editor diagnostics depend on language extensions, which were disabled
  in the test instance.

### R-006 Adaptive execution policy
- Status: done

Files Changed:
- src/agent/ (classifier, taskState, runtime)
- src/tools/ (builtin/updatePlan, types, index)
- src/chat/controller.ts
- tests/unit/ (classifier, taskState), tests/integration/modes.test.ts,
  tests/extension/modes.test.ts

What Changed:
- Deterministic classifier returning mode, intent, scope, risk,
  verification need, a heuristic confidence score and reasons.
- Quick: few files, no plan tool, 12 steps. Standard: plan tool
  available, 24 steps. Project: tracked task with goal, acceptance
  criteria and steps, 48 steps, and a reminder if no plan is recorded.
- Escalation from facts of the running task (files proposed, files read,
  steps used), with the new mode's instructions and tools applied at once.
- A mode chosen by the user is kept: no automatic escalation, and the
  transcript says what ByteAgent would have picked.
- Task state machine with validated transitions and plan updates.

Why:
- Milestone 6 exit criteria.

Decision recorded: classification uses heuristics plus escalation only.
Model-assisted classification was not added because nothing measured so
far shows it would help.

Verification (2026-11-13):
- `npm run typecheck`: no errors.
- `npm test`: 22 files, 476 tests passed, including a 45-request
  classification table, escalation thresholds, and review, command
  approval and blocked files checked in each of the three modes.
- `npm run test:extension`: 43 tests passed in VS Code 1.142.0.

Not verified:
- The classifier was calibrated on English example requests written for
  the tests. Accuracy on real user requests, and on other languages, is
  unknown.
- Tasks do not survive a restart yet (R-007).

### R-007 Persistent project knowledge and onboarding
- Status: done

Files Changed:
- src/project/ (store, onboarding, docsSync)
- src/agent/runtime.ts (resume brief, file revalidation)
- src/chat/ (controller, workspaceService), src/commands/index.ts,
  src/extension.ts
- tests/unit/ (store, onboarding), tests/integration/resume.test.ts,
  tests/extension/project.test.ts

What Changed:
- SQLite store (sql.js) for tasks, run events, command evidence, file
  index and symbols. Written atomically shortly after each change. An
  unreadable database is kept as a backup file, not deleted.
- The database stays in VS Code's storage for the workspace until the
  developer approves project setup; then it moves to
  `.byteagent/agent.db`, which the generated `.gitignore` excludes.
- "Set Up Project Knowledge" scans the project and proposes
  `.byteagent/context.md`, `project_status.md`, `roadmap.md`,
  `decisions.md`. Facts (with sources), inferences and unknowns are kept
  apart. Nothing is claimed to work. No roadmap items are invented.
  Existing files are never replaced. `AGENTS.md` only on request.
- New projects: requirements given by the developer become proposed
  roadmap items.
- `.byteagent/context.md` is included in the system prompt.
- After a tracked task changes, only the marked task section of the
  status document is offered for update, through the normal review. A
  declined update is not offered again until the tasks change.
- Resume: an unfinished task continues in a new conversation from stored
  state (goal, criteria, plan, recorded results), with files it changed
  re-checked against their recorded hashes. No earlier conversation is
  replayed, so any provider can continue it.

Why:
- Milestone 7 exit criteria.

Verification (2026-11-13):
- `npm run typecheck`: no errors.
- `npm test`: 25 files, 509 tests passed.
- `npm run test:extension`: 52 tests passed in VS Code 1.142.0,
  including rejected setup writing nothing, approved setup creating the
  files and moving the database, edited knowledge never overwritten, a
  task listed after the database was closed and reopened, and the task
  continued on a second provider with no request to the first.

Not verified:
- "Restart" was simulated by closing and reopening the database inside
  one VS Code test instance, not by quitting and starting VS Code.
- Two VS Code windows on the same folder each hold their own copy of the
  database in memory; the last one to write wins. Not tested, not handled.
- Database size and speed with thousands of tasks or a very large file
  index were not measured.

### R-008 Indexing improvements (light)
- Status: done

Files Changed:
- src/context/ (symbols, ranker, contextBuilder, workspaceIndex)
- src/agent/runtime.ts, src/chat/ (workspaceService, controller)
- tests/unit/symbols.test.ts, tests/perf/retrieval.test.ts

What Changed:
- Incremental index updates: a file event updates one path instead of
  rescanning the workspace.
- Line-pattern symbol extraction for TypeScript, JavaScript, Python, Go,
  Rust, Java-style languages, Ruby, PHP and C-style languages, with an
  index that re-reads only changed files.
- Ranking uses declared names, including phrases written in plain words
  ("order total" finds `calculateOrderTotal`).

Measured (2026-11-13, this machine, `tests/perf/retrieval.test.ts`):
- Retrieval on an 18-query set over a 61-file sample project: correct
  file ranked first 15 of 18 without the symbol index, 18 of 18 with it;
  mean reciprocal rank 0.833 to 1.000.
- 3,000 files: full rescan after one change 197 ms; incremental update
  of one path under 1 ms.
- 3,000 files: first symbol build 1,181 ms (6,000 symbols); update after
  two changed files 20 ms.

Not verified:
- The query set and sample project were written for this measurement.
  They show the gap the change addresses; they do not prove the same gain
  on a real repository.
- Symbol extraction uses line patterns, not a parser. It misses unusual
  declaration styles and was not checked against large real code bases.
- The stored symbols are a snapshot taken at project setup; ranking uses
  the live in-memory index.

Not built (deferred as R-009): Tree-sitter parsing, dependency graph,
embeddings, semantic search, native provider adapters.

### Release check: required scenarios and packaging
- Status: done

The seven scenarios in `DEVELOPMENT_PLAN.md` section 13, and where each
is tested:

| Scenario | Tested in |
|---|---|
| A: read-only question | tests/integration/contextRuntime.test.ts, modes.test.ts; tests/extension/context.test.ts |
| B: small edit | tests/integration/modes.test.ts; tests/extension/changes.test.ts |
| C: multi-file feature | tests/integration/modes.test.ts, commands.test.ts |
| D: large task, resume after restart | tests/integration/modes.test.ts, resume.test.ts; tests/extension/project.test.ts |
| E: switch provider mid-task | tests/integration/resume.test.ts; tests/extension/project.test.ts |
| F: rejected change | tests/unit/changes.test.ts; tests/integration/agentTools.test.ts; tests/extension/changes.test.ts |
| G: file changed after preview | tests/unit/changes.test.ts; tests/integration/agentTools.test.ts; tests/extension/changes.test.ts |

Final verification (2026-11-13):
- `npm run typecheck`: no errors.
- `npm test`: 27 files, 518 tests passed.
- `npm run test:extension`: 52 tests passed in VS Code 1.142.0.
- `npm run test:vsix`: `byteagent.vsix` (616 KB, 10 files) installed into
  a clean VS Code profile; the same 52 tests passed against the
  installed, minified build.
- Chat UI checked visually through the browser harness: first-run setup,
  provider list, empty chat, streaming answer, change review, command
  approval (including a destructive command), plan, outcome, error,
  history, mode and model menus, file mention list, dark and light
  themes, 300 px and 420 px widths.

Not verified, across the whole product:
- No real provider has been used. Every model reply in the tests comes
  from the scripted mock server, so real models' tool-calling habits,
  streaming quirks and error formats are untested.
- The chat UI was never clicked inside VS Code. Its logic was driven
  through the message protocol in a real VS Code instance, and its
  appearance was checked in headless Chrome with approximated theme
  colours.
- Only Linux was tested. macOS and Windows are untested, including
  process termination, path handling and the recycle bin.
- No accessibility review was done beyond labelled controls and focus
  styles.

---

## In Progress
None

---

## Pending
- R-010 Release readiness (needs the product owner): live-provider
  testing, licence terms, third-party licence review, Marketplace
  publisher.

---

## Blockers
None
