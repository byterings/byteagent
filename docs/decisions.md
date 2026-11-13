# Decisions

Confirmed architectural and product decisions. Add a new entry when a
material decision is made. Do not rewrite old entries; supersede them.

## D-001: Follow DEVELOPMENT_PLAN.md milestone numbering

- Date: 2026-11-13
- Decision: Milestones 0–8 from `DEVELOPMENT_PLAN.md` are the working
  sequence. Roadmap IDs map one to one: `R-000` is Milestone 0, `R-008` is
  Milestone 8.
- Reason: README.md lists seven coarser milestones. One numbering avoids
  confusion.

## D-002: Scope of this build

- Date: 2026-11-13
- Decision: Build Milestones 0–7 completely. From Milestone 8 build only
  incremental index updates and lightweight symbol extraction.
- Not included: embeddings, vector search, Tree-sitter, native provider
  adapters.
- Reason: The plan requires a measured gap before adding those.

## D-003: Core logic does not import `vscode`

- Date: 2026-11-13
- Decision: Only thin adapter files import the `vscode` module. A test
  enforces the boundary.
- Reason: Fast deterministic tests and a clean provider/agent separation.

## D-004: esbuild for the extension, Vite + React for the webview

- Date: 2026-11-13
- Decision: Two bundles in `dist/`.
- Reason: Small, fast, and standard for VS Code extensions with a custom UI.

## D-005: Sidebar webview as the chat surface

- Date: 2026-11-13
- Decision: ByteAgent has its own activity-bar icon and a sidebar chat view
  styled with VS Code theme variables.
- Reason: Matches what users of current coding agents expect, and follows
  light, dark and high-contrast themes automatically.

## D-006: Native tool calling with a text fallback

- Date: 2026-11-13
- Decision: Use the endpoint's native tool calling. When the endpoint does
  not support it, use a text protocol where the model writes tool calls in
  fenced blocks.
- Reason: "OpenAI-compatible" endpoints differ widely in tool support.

## D-007: Edits are proposed through one tool

- Date: 2026-11-13
- Decision: The model edits files only through `propose_changes`, which
  accepts whole-file writes, exact search-and-replace edits, and deletions.
  All are normalised to full new content plus a base hash.
- Reason: One review path, one staleness check, no direct write tool.

## D-008: SQLite through WebAssembly (sql.js)

- Date: 2026-11-13
- Decision: Use `sql.js` for `.byteagent/agent.db`.
- Reason: Native SQLite modules must be compiled per platform and per
  Electron version. WebAssembly runs everywhere the extension runs and in
  the test runner.
- Trade-off: The database is held in memory and written to disk as a whole.
  Acceptable for task state and a file index; revisit if it grows large.

## D-009: Command approval policy

- Date: 2026-11-13
- Decision: Every command asks first. The user may choose "always allow"
  for an exact safe command in the current workspace. Destructive and
  chained commands are never remembered.
- Reason: Chosen by the product owner; balances safety with test-fix loops.

## D-010: Testing against a mock provider

- Date: 2026-11-13
- Decision: All automated tests use a local mock OpenAI-compatible server.
  No live provider is required or used.
- Consequence: Behaviour against real providers is unverified until tested
  manually with a real key.

## D-011: Local file-system workspaces only

- Date: 2026-11-13
- Decision: Workspace access uses Node.js file APIs on `file:` workspace
  folders.
- Reason: Simpler and testable outside VS Code. Remote and virtual
  workspaces are a later enhancement.

## D-012: Development documents stay at the repository root

- Date: 2026-11-13
- Decision: This repository keeps `context.md`, `project_status.md` and
  `roadmap.md` at the root, as `AGENTS.md` expects. The `.byteagent/`
  layout in README.md describes what ByteAgent generates for the projects
  it manages.

## D-013: Git workflow

- Date: 2026-11-13
- Decision: `main` holds released states. Development happens on `dev`
  with a commit after each coherent change.
