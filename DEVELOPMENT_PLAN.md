# ByteAgent Development Plan

**Version:** 1.0\
**Status:** Proposed execution plan\
**Product:** Free-to-use, proprietary VS Code coding agent\
**Default policy:** Automatic task classification; preview all proposed
code changes before applying

## 1. How to use this plan

Use this document as the implementation sequence for Codex, Claude, or
another coding agent. Work one milestone at a time. Do not ask an AI
coding tool to implement the entire roadmap in one enormous task.

At the beginning of each milestone, the coding agent must:

1.  Read `README.md`, `AGENTS.md` if present, and the current project
    status/roadmap documents if present.
2.  Inspect the actual repository, package scripts, dependencies, and
    tests.
3.  Identify completed work and gaps. Never assume that planned work is
    already implemented.
4.  Propose a bounded plan with files likely to change and tests to run.
5.  Wait for approval before modifying project files if the active
    execution policy requires it.
6.  Implement only the approved milestone scope.
7.  Run relevant tests and report exact outcomes.
8.  Update status and roadmap based on verified results.

If the repository is empty, initialize it according to this plan. If
code already exists, adapt the plan to the repository rather than
replacing existing work.

## 2. Product decisions to preserve

-   Product name: ByteAgent (working name).
-   Client: Visual Studio Code extension.
-   Primary language: TypeScript.
-   Initial provider support: configurable OpenAI-compatible endpoint.
-   Provider layer and agent runtime remain independent.
-   Free-to-use, proprietary implementation, bring-your-own API key.
-   API keys stored in VS Code SecretStorage.
-   Local-first indexing and project state.
-   Context is selected per task; the whole repository is never sent by
    default.
-   Automatic execution classification: Quick, Standard, Project.
-   Proposed file changes always require explicit user approval before
    application.
-   Project state is provider-independent and survives session changes.
-   Project status must be evidence-based.
-   Avoid unnecessary roadmap/context generation for simple tasks.
-   Avoid adding embeddings, multi-agent systems, or elaborate plugin
    infrastructure before the core vertical slice works.

## 3. Initial repository structure

Start with a modest structure. Do not create many packages merely for
the appearance of modularity.

``` text
byteagent/
├── README.md
├── DEVELOPMENT_PLAN.md
├── AGENTS.md
├── package.json
├── tsconfig.json
├── .gitignore
├── docs/
│   ├── architecture.md
│   ├── provider-contract.md
│   ├── security.md
│   └── decisions.md
├── src/
│   ├── extension.ts
│   ├── commands/
│   ├── chat/
│   ├── providers/
│   ├── agent/
│   ├── context/
│   ├── tools/
│   ├── changes/
│   ├── project/
│   └── shared/
└── tests/
    ├── unit/
    ├── integration/
    └── extension/
```

This is a starting layout, not a requirement to preserve every folder.
Add boundaries when a responsibility has a clear contract and can be
tested independently.

## 4. Milestone 0: Repository audit and technical design

### Objective

Establish what exists and agree on the smallest viable architecture
before implementation.

### Tasks

-   Inspect the repository and current Git state.
-   Identify existing source, build scripts, extension manifest, tests,
    dependencies, licenses, and documentation.
-   Confirm the supported VS Code engine version and Node/TypeScript
    compatibility.
-   Write `docs/architecture.md` with module responsibilities and
    dependency direction.
-   Write `docs/provider-contract.md` with normalized request/response
    and capability requirements.
-   Write `docs/security.md` describing secrets, context exclusions,
    file changes, and command permissions.
-   Record material decisions in `docs/decisions.md`.
-   Create or update the roadmap using real implementation status.

### Exit criteria

-   Existing code is understood well enough to avoid duplicating
    functionality.
-   The first vertical slice is defined.
-   Provider-independent boundaries and the change-review policy are
    documented.
-   Tests and validation commands are identified.

## 5. Milestone 1: VS Code extension foundation

### Objective

Create a buildable, testable extension with commands and settings.

### Tasks

-   Initialize or repair the extension project.
-   Configure TypeScript, linting/formatting if selected, and test
    scripts.
-   Add activation and deactivation lifecycle.
-   Add a ByteAgent activity/chat entry point or the simplest
    appropriate VS Code UI.
-   Register commands for opening chat and opening settings.
-   Define configuration keys for provider name, Base URL, model,
    timeout, and generation options.
-   Store API keys using VS Code SecretStorage.
-   Add structured error handling and minimal local diagnostics.
-   Ensure secrets never enter logs, source control, or ordinary
    settings.

### Exit criteria

-   Extension builds and activates in the Extension Development Host.
-   Commands work.
-   Configuration can be read and validated.
-   A secret can be saved and retrieved through SecretStorage.
-   Unit tests cover configuration validation and error cases.

## 6. Milestone 2: Provider contract and streaming chat

### Objective

Send a user message to one configured OpenAI-compatible endpoint and
stream the response.

### Tasks

-   Define a provider-neutral interface, for example:
    -   `chat()`
    -   `stream()`
    -   `testConnection()`
    -   `listModels()` where supported
    -   `getCapabilities()`
-   Define normalized message, tool, usage, error, and streaming event
    types.
-   Implement the generic OpenAI-compatible chat adapter.
-   Support cancellation and request timeout.
-   Parse streaming responses robustly and handle incomplete/error
    streams.
-   Validate Base URL and model configuration.
-   Add safe redaction for credentials and sensitive request metadata.
-   Display provider errors in a useful, non-secret-revealing way.
-   Add mock-based tests; do not require a paid API in CI.

### Exit criteria

-   A user can configure an endpoint and receive a streamed response.
-   Cancellation and timeouts work.
-   Provider errors do not crash the extension.
-   The agent core imports no vendor-specific SDK types.
-   Tests run without live credentials.

### Explicit non-goals

Do not implement multiple native provider adapters, embeddings,
autonomous tool loops, or model orchestration in this milestone.

## 7. Milestone 3: Workspace discovery and context v1

### Objective

Let ByteAgent inspect a workspace without sending the full repository to
the model.

### Tasks

-   Discover workspace roots and repository metadata.
-   Respect `.gitignore`, configured exclusions, binary files, and size
    limits.
-   Detect common technologies by inspecting manifests and configuration
    files.
-   Implement file listing and text search using VS Code APIs and/or
    ripgrep where available.
-   Add read-file and bounded-range retrieval.
-   Track file metadata and content hashes.
-   Build a basic relevance ranker using request terms, path/name
    matches, open editor state, and search results.
-   Build a context package with a configurable token budget.
-   Estimate tokens conservatively and reserve output capacity.
-   Record omitted context when budget limits prevent inclusion.
-   Do not index secrets or transmit excluded files.

### Exit criteria

-   A prompt can retrieve a small set of relevant files.
-   Unrelated files are not included without a reason.
-   Large files and binary files are handled safely.
-   Changes to files invalidate cached content.
-   Tests cover exclusions, ranking, truncation, and token budgeting.

## 8. Milestone 4: Safe patch proposals and diff review

### Objective

Allow the model to propose file edits without applying them
automatically.

### Tasks

-   Define a normalized proposed-change format.
-   Support creation and modification of files; support deletion only
    with explicit review and additional safeguards.
-   Validate paths against the workspace and exclusion rules.
-   Capture base content hashes for affected files.
-   Render changes in the VS Code diff editor or an equivalent review
    interface.
-   Implement Accept, Reject, and Revise workflows.
-   Revalidate hashes and patch applicability at acceptance time.
-   Detect concurrent edits and require a refreshed preview when
    necessary.
-   Apply only the exact approved proposal.
-   Preserve enough information to report partial application failures.
-   Refresh file metadata and context indexes after application.

### Exit criteria

-   No proposed file change is applied before explicit user approval.
-   Rejected changes are not applied.
-   Stale proposals cannot silently overwrite newer content.
-   Multiple files can be reviewed.
-   Application failures are reported accurately.
-   Tests cover accept, reject, stale file, invalid path, and partial
    failure cases.

### Important security boundary

Diff approval does not authorize arbitrary terminal commands. Command
execution will have its own permission and risk controls.

## 9. Milestone 5: Tool manager and verification

### Objective

Introduce controlled tools and make verification results part of task
state.

### Initial tools

-   Read file
-   Search files
-   List directory
-   Propose file changes
-   Git status
-   Git diff
-   Run an explicitly approved command
-   Run tests or diagnostics through an approved command

### Tasks

-   Define tool ID, description, input schema, validation, permission
    class, execution result, and cancellation behavior.
-   Validate all model-provided tool arguments.
-   Enforce permissions in the runtime, not only through prompt
    instructions.
-   Capture stdout/stderr with limits and redaction.
-   Apply timeouts and cancellation.
-   Classify commands by risk; require explicit approval for destructive
    or high-impact operations.
-   Record actual test exit codes and summaries.
-   Do not mark verification as passed if it did not run.
-   Avoid adding commit, reset, database mutation, Docker, or Kubernetes
    automation until their policies are separately specified.

### Exit criteria

-   Tools are registered and invoked through a common interface.
-   Invalid arguments and disallowed operations are blocked.
-   Commands can be cancelled and time out.
-   Verification evidence is structured and persisted.
-   Unit and integration tests cover permission and failure cases.

## 10. Milestone 6: Adaptive execution policy

### Objective

Implement automatic task classification and the Quick/Standard/Project
workflows.

### Tasks

-   Define a structured `TaskClassification` result.
-   Implement deterministic initial heuristics for intent, scope, risk,
    and verification requirements.
-   Add confidence and reason fields, calibrated against tests rather
    than interpreted as certainty.
-   Use model-assisted classification only when it provides value;
    validate its output.
-   Implement Quick mode with minimal retrieval and no formal roadmap
    requirement.
-   Implement Standard mode with targeted planning and verification.
-   Implement Project mode with persistent tasks, dependencies,
    milestones, and resume support.
-   Escalate when actual scope or risk exceeds the initial
    classification.
-   Keep safety and review policies identical across modes.
-   Allow user overrides without permitting safety-policy bypass.
-   Test ambiguous requests and classification regressions.

### Exit criteria

-   Simple questions do not trigger unnecessary project-wide scans.
-   Local changes use targeted context.
-   Multi-module work can use persistent plans.
-   Escalation works.
-   All proposed code edits still require preview and approval.

## 11. Milestone 7: Persistent project knowledge and onboarding

### Objective

Support new and existing projects without requiring developers to
manually explain the repository each time.

### Tasks

-   Add local structured storage for file metadata, symbols where
    available, tasks, and execution events.
-   Add project initialization for new and existing repositories.
-   Detect existing instruction and documentation files before
    generating new ones.
-   Preserve user-owned documents and rules.
-   Generate or update:
    -   `AGENTS.md` only when requested or explicitly approved
    -   `.byteagent/context.md`
    -   `.byteagent/project_status.md`
    -   `.byteagent/roadmap.md`
    -   `.byteagent/decisions.md`
-   Separate discovered facts, inferences, and unknowns.
-   Treat the roadmap as planned work, not proof of implementation.
-   Use code and verification evidence to establish actual status.
-   Keep a structured source of truth for tasks; synchronize Markdown
    carefully.
-   Resume tasks after restart or provider switching.
-   Update only documentation sections made stale by actual changes.

### Exit criteria

-   An existing repository can be scanned and summarized.
-   The baseline does not claim unverified features are complete.
-   A task can continue after changing providers.
-   Documentation remains consistent with structured state.
-   Simple tasks do not require project-wide documentation generation.

## 12. Milestone 8: Indexing improvements and optimization

### Objective

Improve retrieval quality based on measured problems, not speculation.

### Candidate enhancements

-   Language-aware parsing and Tree-sitter
-   Route discovery for supported frameworks
-   Symbol references and dependency graph
-   Incremental index updates
-   More precise token counting
-   Prompt caching where supported
-   Embeddings and semantic search
-   Better context compression
-   Optional native provider adapters

### Exit criteria

Each enhancement must demonstrate measurable improvement in retrieval
quality, latency, token usage, or reliability and must have tests. Do
not add a vector database solely because it is fashionable.

## 13. Required end-to-end scenarios

The release should pass these scenarios:

### Scenario A: Read-only question

User asks what a function does.

Expected: - Retrieve the function and necessary nearby context. - No
file diff is created. - No roadmap is generated. - Answer references the
relevant source location when possible.

### Scenario B: Small edit

User asks to change a local style value.

Expected: - Quick classification. - Relevant file retrieval only. -
Proposed diff is shown. - No edit is applied before approval. - Relevant
checks run where practical.

### Scenario C: Multi-file feature

User asks to add an API endpoint and tests.

Expected: - Standard classification or escalation. - Related routes,
services, models, and tests are retrieved. - A concise plan is
produced. - Changes are reviewed before application. - Tests and actual
results are recorded.

### Scenario D: Large architectural task

User requests a cross-module authentication system.

Expected: - Project mode. - Existing implementation and architecture are
inspected. - Acceptance criteria and task dependencies are persisted. -
Changes are staged and reviewed. - Milestones and verification results
are recorded. - Work can resume after restart.

### Scenario E: Switch provider mid-task

Expected: - Same task ID and project state. - New provider receives a
refreshed context package. - No dependence on private conversation
history from the previous provider. - Existing files are revalidated
before resuming.

### Scenario F: Rejected change

Expected: - Proposed patch is previewed. - User rejects it. - Patch
remains unapplied. - Task state records rejection where appropriate. -
Agent can revise or stop without claiming the change was made.

### Scenario G: External file changed after preview

Expected: - Acceptance detects a stale base hash. - ByteAgent does not
silently overwrite the change. - A new proposal/preview is generated.

## 14. Engineering quality gates

Every milestone must include:

-   Type checking
-   Unit tests for new logic
-   Integration tests for affected boundaries
-   Extension build/activation validation where applicable
-   Secret redaction checks
-   Permission and failure-path tests
-   Documentation updates when behavior or architecture changes
-   A concise implementation report

Use mocked providers for deterministic tests. Keep live-provider tests
optional and explicitly configured.

Avoid broad refactors unrelated to the active milestone. Do not add
dependencies without a reason, and review their licenses before
distribution.

## 15. Instructions for Codex or Claude

Use the following as the initial implementation prompt:

> You are implementing ByteAgent, a provider-agnostic AI coding agent
> for VS Code. Read `README.md` and `DEVELOPMENT_PLAN.md`, then inspect
> the actual repository and all existing project instructions before
> editing anything.
>
> First report the current repository state, existing stack, implemented
> functionality, tests, and gaps. Do not assume the project is empty or
> that roadmap items are already implemented.
>
> Recommend the smallest useful next milestone and list the expected
> files and tests. Preserve existing user work and architecture unless a
> change is justified. Do not implement the entire roadmap in one pass.
>
> ByteAgent's non-negotiable policies are: provider-independent agent
> logic; local-first, selective context; automatic
> Quick/Standard/Project classification; persistent provider-independent
> task state; secure API-key storage; and explicit diff preview and user
> approval before applying any project-file changes. High-risk commands
> require separate authorization.
>
> After approval, implement only the agreed scope. Run the relevant
> tests and checks, report exact commands and results, identify
> unverified behavior, and update project status and roadmap only based
> on actual evidence. Never claim a test passed if it was not run.
>
> Begin with a repository audit and milestone proposal. Do not start
> coding until the audit and proposed first milestone have been
> reported.

## 16. Immediate next action

Start with **Milestone 0: Repository audit and technical design**. Then
implement Milestone 1 and Milestone 2 to prove the extension lifecycle,
secure configuration, provider abstraction, and streaming chat.

Only after those work reliably should implementation proceed to context
retrieval and safe editing. The first major product proof is the
complete path from a user prompt to a streamed model response and a
safely reviewed, verifiable code change.
