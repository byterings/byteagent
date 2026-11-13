# Security Model

ByteAgent's safety rules are enforced in code. Prompts tell the model what
the rules are, but no rule depends on the model obeying.

## 1. Secrets

- API keys are stored only in VS Code SecretStorage, one entry per provider
  profile (`byteagent.apiKey.<profileId>`).
- Keys are never written to settings, workspace files, the SQLite store,
  chat history, or logs.
- The webview never receives a key. It only learns whether a key exists.
- All log lines and all error text shown to the user pass through
  `src/shared/redact.ts`, which removes the active key, `Authorization`
  headers, bearer tokens, and common key patterns.

## 2. What may be sent to the provider

Nothing is sent merely because it exists in the workspace. A file's content
reaches the provider only when:

1. the user attached or mentioned it, or
2. the context ranker selected it for this request, or
3. the model asked for it through the `read_file` or `search_files` tool,

and, in every case, the file passes the exclusion check below.

The chat UI lists the files included in each request. The setting
`byteagent.context.confirmBeforeSend` adds an explicit confirmation step.

## 3. Exclusions

`src/context/ignore.ts` decides whether a path is readable by the agent.
A path is blocked when any of these match:

| Rule | Examples |
|---|---|
| Outside every workspace root (after resolving symlinks) | `../other`, `/etc/passwd` |
| Version-control internals | `.git/` |
| `.gitignore` rules | `node_modules/`, `dist/` |
| User exclusions (`byteagent.context.exclude`) | project specific |
| Built-in sensitive-file rules | `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `*.p12`, `.npmrc`, `.netrc`, `credentials.json`, `secrets.*` |
| Binary content or over the size limit | images, archives, large data files |

Sensitive files are never indexed, never returned by search, never read by
tools, and cannot be the target of a proposed change.

## 4. File changes

- The model cannot write files. It can only call `propose_changes`.
- Every proposal is validated: the path must be inside the workspace, not
  excluded, and not a sensitive file.
- The base content hash of each affected file is captured when the proposal
  is created.
- The user reviews a real diff and accepts or rejects each file.
- At acceptance time the hash is checked again. If the file changed on disk
  or in an unsaved editor, the change is refused as stale and a new proposal
  is required.
- Only the exact reviewed content is written.
- Deletions are shown as deletions and need the same explicit approval.
- Partial failures are reported per file. A failed file is never reported
  as applied.

## 5. Commands

Approving a diff does not approve any command. Commands have their own gate.

Every command the model wants to run is classified by
`src/tools/commandRisk.ts`:

| Risk | Meaning | Examples | Policy |
|---|---|---|---|
| `safe` | Reads state or runs project checks | `npm test`, `git status`, `tsc --noEmit` | Asks. May be remembered with "always allow" for the exact command in this workspace |
| `moderate` | Changes local state in a recoverable way | `npm install`, `git add`, `mkdir` | Asks every time |
| `destructive` | Deletes data, rewrites history, touches databases, containers or remote systems, or pipes downloads into a shell | `rm -rf`, `git reset --hard`, `git push --force`, `DROP TABLE`, `curl … \| sh` | Asks every time with a warning. Never remembered |

Additional rules:

- Unknown commands are `moderate`, never `safe`.
- Shell chaining (`;`, `&&`, `|`, backticks, `$()`) takes the highest risk
  of its parts, and a chained command can never be remembered.
- Commands run in the workspace root with a timeout, an output size limit,
  and cancellation. Output is redacted before it is stored or sent to the
  provider.
- Git commit, push, reset, database mutation, Docker and Kubernetes
  automation are not offered as dedicated tools.

## 6. Tool arguments

All tool arguments come from the model and are untrusted. Each tool has an
input schema, and the registry validates arguments before execution.
Invalid arguments return an error to the model and do nothing else.

## 7. Execution modes

Quick, Standard and Project modes change how much context is gathered and
how much planning happens. They do not change any rule in this document. A
user override of the mode cannot disable review or command approval.

## 8. Webview

- Strict Content Security Policy: scripts only with a per-load nonce, no
  remote content, no inline event handlers.
- Model output is rendered as Markdown and sanitised before insertion.
- Links open through VS Code and only for `http`, `https` and workspace
  file links.

## 9. Evidence

A verification result is recorded only from an actual run: the command, its
exit code, duration, and a redacted output summary. If nothing ran, the
recorded state is "not verified". The final summary shown to the user is
built from these records.

## 10. Known limits

- Remote and virtual workspaces (non-`file:` schemes) are not supported yet.
- A provider receives whatever context is selected. ByteAgent cannot control
  how the provider stores or uses it.
- Redaction is pattern-based and cannot recognise every possible secret
  inside file contents. The sensitive-file rules are the main protection.
