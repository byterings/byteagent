# ByteAgent

> A provider-agnostic AI coding agent for Visual Studio Code, designed
> to help developers understand, change, and verify software projects
> using the AI model or compatible API endpoint they choose.

**Project status:** Planning / pre-implementation\
**Product model:** Free to use, proprietary source code, bring your own
API key\
**Initial client:** Visual Studio Code extension\
**Primary implementation language:** TypeScript

## 1. Vision

ByteAgent separates the agent framework from the AI model. The model is
a replaceable reasoning provider; ByteAgent owns project discovery,
context selection, task execution, change review, verification, and
persistent project state.

The intended experience is simple:

1.  Open a project in VS Code.
2.  Connect a compatible AI provider.
3.  Ask a coding question or request a change.
4.  ByteAgent gathers only the relevant project context.
5.  ByteAgent chooses an appropriate execution depth.
6.  Proposed file changes are previewed before application.
7.  ByteAgent verifies the result and records meaningful project-state
    changes.

ByteAgent should work for both newly created projects and existing,
already-developed repositories. Developers should not have to manually
explain an entire codebase every time they change model or start a new
session.

## 2. Product principles

-   **Provider-independent:** Agent logic must not depend on a specific
    model vendor.
-   **Local-first project intelligence:** Indexing, symbol discovery,
    file metadata, task state, and context selection should run locally
    by default.
-   **Selective context:** Never send the entire repository by default.
-   **Adaptive execution:** Simple requests should remain simple;
    complex work should use planning and persistent tracking.
-   **Preview before applying:** No proposed project-file changes are
    applied before explicit user approval.
-   **Evidence-based status:** A model's claim is not proof that code
    works. Record actual tool results and verification evidence.
-   **Persistent project state:** Rules, project knowledge, roadmap,
    task state, and execution history must survive provider and session
    changes.
-   **Security by design:** Protect API keys, respect exclusions, and
    enforce permissions independently of model instructions.
-   **Incremental development:** Deliver a tested vertical slice before
    adding advanced indexing, embeddings, or multi-agent features.

## 3. Initial technology stack

  -----------------------------------------------------------------------
  Area                                Initial choice
  ----------------------------------- -----------------------------------
  Language                            TypeScript

  IDE integration                     VS Code Extension API

  Runtime                             Node.js provided by the VS Code
                                      extension host

  Chat UI                             VS Code Webview; React + Vite if a
                                      custom UI is needed

  Provider transport                  HTTP/fetch streaming and provider
                                      adapters

  Local structured data               SQLite, introduced when persistent
                                      indexing/task data is needed

  File and text search                VS Code workspace APIs and ripgrep
                                      where available

  Code parsing                        Language-specific parsers or
                                      Tree-sitter where justified

  Git                                 Git CLI and VS Code Git integration

  Diff                                VS Code diff editor and a
                                      patch/diff library as needed

  Tests                               Vitest plus VS Code Extension Test
                                      API

  Secrets                             VS Code SecretStorage
  -----------------------------------------------------------------------

These are initial choices, not a mandate to introduce every dependency
in the first milestone. Prefer built-in VS Code and Node.js capabilities
where they meet the requirement.

## 4. Provider architecture

Users should be able to configure a provider using:

-   Provider display name
-   Base URL
-   API key
-   Model name
-   Optional generation settings such as temperature, output-token
    limit, and timeout

The generic OpenAI-compatible adapter is the first integration target.
Native provider adapters may be added when they offer meaningful
capabilities or are needed for endpoints that are not fully
OpenAI-compatible.

A compatible URL does not guarantee support for every feature. The
provider layer must expose capabilities such as streaming, tool calling,
structured output, embeddings, and context limits where known.
Unsupported features must degrade gracefully or produce a clear error.

The provider layer is responsible for API protocol details. It must not
own project memory, task state, code indexing, or execution policy.

API keys must be stored in VS Code SecretStorage, never committed to the
repository, and never written to ordinary logs.

## 5. Adaptive execution policy

ByteAgent automatically classifies tasks into three execution modes.

### Quick

For small, local, low-risk tasks: explain a function, change a simple
style value, or fix an isolated issue.

-   Minimal context retrieval
-   No formal roadmap requirement
-   Short or implicit plan
-   Proportionate verification
-   No unnecessary project-document rewrites

### Standard

For moderate changes involving related files or components.

-   Targeted architecture and dependency inspection
-   Concise plan
-   Relevant source retrieval
-   Focused tests and diagnostics
-   Update project state only when meaningful

### Project

For complex work across modules, architectural changes, or multi-step
features.

-   Inspect existing implementation
-   Define acceptance criteria and dependencies
-   Persist task and milestone state
-   Execute in bounded steps
-   Verify at milestones
-   Support interruption and resumption
-   Update relevant documentation based on evidence

The classifier may escalate when the real scope is larger than initially
expected. A mode selection must never bypass security or permission
requirements.

## 6. Change review policy

**All proposed project-file changes require explicit user approval
before application.**

The workflow is:

1.  Prepare a proposed change set.
2.  Validate file paths, permissions, and patch applicability.
3.  Display a diff preview.
4.  Allow the user to accept, reject, or revise.
5.  Revalidate file hashes before applying to detect concurrent edits.
6.  Apply only approved changes.
7.  Refresh indexes and run relevant verification.
8.  Record the actual result.

Read-only questions do not need a diff. Terminal commands and external
side effects require a separate permission policy; approving a file diff
does not authorize destructive shell commands or database operations.

## 7. Project intelligence and persistent knowledge

ByteAgent should preserve a simple, understandable project-documentation
model:

-   `AGENTS.md`: operating rules and permissions, controlled by the
    developer.
-   `.byteagent/context.md`: architecture and project facts.
-   `.byteagent/project_status.md`: actual task state and verification
    status.
-   `.byteagent/roadmap.md`: planned work.
-   `.byteagent/decisions.md`: confirmed architectural decisions.
-   `.byteagent/architecture/`: optional detailed architecture maps.
-   `.byteagent/tasks/`: optional human-readable task records.
-   `.byteagent/agent.db`: structured local index, symbols, hashes,
    tasks, and execution events.

The implementation must also support repositories with existing
instruction and documentation files. Do not overwrite user-owned
documents during onboarding.

For an existing project, ByteAgent should discover the repository,
detect technologies, index files and symbols where supported, identify
test/build commands, and generate a baseline with explicit uncertainty
labels. The roadmap should be proposed, not invented as established
fact.

For a new project, ByteAgent can initialize the same knowledge structure
from user-provided requirements.

The SQLite store should be the authoritative source for structured task
state. Human-readable documents should be generated or synchronized in a
controlled way to avoid conflicting duplicate facts.

## 8. Context strategy

Context is assembled per request, not loaded wholesale.

Always include the minimum instructions needed for safe operation and
the active request. Retrieve other information as needed:

-   Relevant files and symbols
-   Nearby definitions and references
-   Related project rules
-   Task acceptance criteria and current state
-   Relevant architecture decisions
-   Recent execution events
-   Roadmap dependencies for complex tasks

The context engine should rank information, remove duplication, estimate
tokens, reserve output capacity, and retrieve more context only when
required. Provider-specific tokenization and prompt caching may be used
when available, but local caching must not be confused with reduced API
billing.

## 9. Security and privacy

-   Store provider secrets in VS Code SecretStorage.
-   Keep repository indexing local by default.
-   Respect `.gitignore`, ByteAgent exclusions, and configured
    sensitive-file rules.
-   Do not transmit files merely because they exist in the workspace.
-   Clearly identify which context will be sent to the configured
    provider.
-   Enforce permissions in code, not only in prompts.
-   Require explicit approval for file changes.
-   Gate destructive commands, database migrations, and high-impact Git
    operations separately.
-   Support cancellation, timeouts, bounded retries, and recoverable
    error states.
-   Never claim a task passed tests unless the tests actually ran and
    results were captured.

## 10. Development milestones

1.  **Foundation:** extension skeleton, settings, secure credentials,
    provider abstraction, streaming chat.
2.  **Workspace discovery:** repository scanning, exclusions, project
    detection, search and basic context assembly.
3.  **Safe editing:** file tools, patch proposals, diff preview,
    accept/reject, stale-file checks and application.
4.  **Verification and tools:** terminal policy, Git status/diff, tests,
    diagnostics, cancellation and error handling.
5.  **Adaptive agent:** classifier, Quick/Standard/Project modes,
    escalation and task state machine.
6.  **Persistent project intelligence:** project onboarding, generated
    baseline, SQLite store, task/roadmap synchronization and resume.
7.  **Advanced indexing:** symbol graph, dependency relationships,
    semantic search and embeddings only when justified by measured gaps.

The sequence may be adjusted based on dependencies, but each milestone
must be tested before expanding scope.

## 11. Definition of a useful first release

The first meaningful vertical slice should let a user:

1.  Install and open ByteAgent in VS Code.
2.  Configure an OpenAI-compatible endpoint and model securely.
3.  Send a prompt and receive a streamed response.
4.  Ask ByteAgent to inspect a selected part of the workspace.
5.  Request a small multi-file change.
6.  Review the actual diff and explicitly approve or reject it.
7.  Apply approved changes and run a relevant verification step.
8.  See a truthful summary of what changed and what was verified.

Do not start with embeddings, multi-agent orchestration, a marketplace,
or a broad plugin ecosystem. First prove that provider configuration,
context retrieval, safe editing, and verification work reliably.

## 12. Project status and contribution rules for AI coding tools

AI coding tools such as Codex or Claude may assist with implementation,
but they must follow the repository's instructions and work in small,
verifiable milestones.

Before implementation:

-   Inspect the current repository and existing instructions.
-   Identify what already exists before creating new files.
-   Propose a short implementation plan.
-   Do not replace the architecture or stack without explaining the
    reason.

After implementation:

-   Run relevant tests and checks.
-   Report exact commands and outcomes.
-   List changed files.
-   Identify unverified behavior and remaining risks.
-   Update project status and roadmap only when warranted.
-   Never claim tests passed if they were not run.

## 13. Non-goals for the initial release

-   Building or hosting an AI model
-   Paying for hosted inference on behalf of users
-   Sending the whole repository to the model
-   Requiring a cloud account for local project indexing
-   Automatically applying code changes without approval
-   Implementing every language parser before the first release
-   Requiring embeddings or a vector database for basic search
-   Supporting every vendor-specific feature on day one

## 14. License and distribution

ByteAgent is intended to be free to use but proprietary. Source code
ownership, third-party dependency licenses, Marketplace requirements,
and distribution terms must be reviewed before release. Free use does
not mean that external model API usage is free; users may incur charges
from their chosen provider.

## 15. Current status

This document describes the intended product and architecture. It does
not claim that these features have already been implemented.

The first engineering task is to inspect the actual repository, record
its current state, and implement the first vertical slice without
creating unnecessary infrastructure.
