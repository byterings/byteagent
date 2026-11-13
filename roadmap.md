# Roadmap

Planned work. An item here is not proof of implementation; see
`project_status.md` for what is actually built and verified.

## Format
- ID
- Title
- Description
- Priority
- Status (`pending`, `in progress`, `done`, `deferred`)

IDs map to milestones in `DEVELOPMENT_PLAN.md`: `R-00N` is Milestone N.

---

## Items

### R-000
- Title: Repository audit and technical design
- Description: Record the repository state, write `docs/architecture.md`,
  `docs/provider-contract.md`, `docs/security.md`, `docs/decisions.md`,
  and replace the template roadmap, context and status documents.
- Priority: High
- Status: done

### R-001
- Title: VS Code extension foundation
- Description: Buildable, testable extension: activation lifecycle,
  sidebar chat entry point, commands, validated settings, API keys in
  SecretStorage, structured errors, redacted logging.
- Priority: High
- Status: pending

### R-002
- Title: Provider contract and streaming chat
- Description: Provider-neutral interface, OpenAI-compatible adapter,
  robust stream parsing, cancellation, timeouts, bounded retries, mock
  server tests, and the streaming chat UI.
- Priority: High
- Status: pending

### R-003
- Title: Workspace discovery and context v1
- Description: Workspace scan, `.gitignore` and sensitive-file exclusions,
  technology detection, search, bounded file reads, content hashes,
  relevance ranking, token-budgeted context package with omitted items.
- Priority: High
- Status: pending

### R-004
- Title: Safe patch proposals and diff review
- Description: Normalised change proposals, path validation, base hashes,
  diff review with accept, reject and revise, stale detection, exact
  application, partial-failure reporting.
- Priority: High
- Status: pending

### R-005
- Title: Tool manager and verification
- Description: Tool registry with schemas and permission classes, argument
  validation, command risk classification and approval, command runner
  with timeout, cancellation and redaction, structured verification
  evidence.
- Priority: High
- Status: pending

### R-006
- Title: Adaptive execution policy
- Description: Deterministic task classifier, Quick, Standard and Project
  workflows, escalation, user override without safety bypass.
- Priority: Medium
- Status: pending

### R-007
- Title: Persistent project knowledge and onboarding
- Description: SQLite store for tasks, events, verification and file
  index; onboarding for new and existing projects; generated
  `.byteagent/` documents; resume after restart and provider switch.
- Priority: Medium
- Status: pending

### R-008
- Title: Indexing improvements (light)
- Description: Incremental index updates and lightweight symbol
  extraction, each with a measured before/after comparison.
- Priority: Low
- Status: pending

### R-009
- Title: Advanced indexing
- Description: Tree-sitter parsing, dependency graph, embeddings and
  semantic search, native provider adapters. Only when a measured gap
  justifies each one.
- Priority: Low
- Status: deferred

### R-010
- Title: Release readiness
- Description: Real-provider testing with live keys, licence terms,
  third-party licence review, Marketplace publisher and listing.
- Priority: Medium
- Status: pending (needs product owner)
