# pi-handoff

`pi-handoff` coordinates fresh Pi Coding Agent sessions using explicit project state instead of relying on an ever-growing conversation.

> Preserve project state, not conversations.

HANDOFF files record the task and its authorized scope. Repository files and Git state remain authoritative. A new session verifies that state before acting.

## Lifecycle architecture

### HANDOFF v2

The semantic checkpoint lives at `.agent/HANDOFF.md`. It records:

- **User Request** and **Authorized Scope**: the task and work permitted across sessions;
- **Work Status**: `IN_PROGRESS`, `COMPLETE`, `BLOCKED`, or `AWAITING_USER`;
- **Current Goal**, **Completed**, **Decisions**, **Files Changed**, and **Tests**;
- **Current State**, **Blockers**, and **Next Step**;
- **Requires User Approval** for work outside the current authorization.

**Next Step is not authorization.** A fresh session may automatically continue only `IN_PROGRESS` work within Authorized Scope. For `COMPLETE`, `BLOCKED`, and `AWAITING_USER`, it verifies the state and waits for the user.

### Resume Guard

An `IN_PROGRESS` handoff is claimed atomically by its content fingerprint. A second continuation from the same checkpoint is blocked. If Pi cancels fresh-session creation or it fails before continuation begins, that claim is released so the checkpoint can be retried. `COMPLETE`, `BLOCKED`, and `AWAITING_USER` do not use this one-shot claim.

### Context Pressure v2

The supervisor records soft pressure at about 65% context and latches hard pressure at about 70%. It checks during active work, including after tool execution completes. Already-running tools are allowed to finish; once hard pressure is latched, later tool calls can be blocked. Handoff preparation waits for a safe lifecycle boundary and uses the normal HANDOFF flow. This aims to preserve project state before Pi's native compaction threshold when possible; native compaction can still occur, and behavior depends on the supported Pi API.

### Crash Recovery

`.agent/RECOVERY.json` is updated during Pi work. An abrupt termination can leave it active. On the next `pi-handoff start`, the journal is preserved as `.agent/RECOVERY.last-crash.json` and Pi starts in Recovery Mode. Recovery is diagnosis-only: the interrupted tool is not replayed, and the agent asks the user how to proceed. Recovery does not consume an `IN_PROGRESS` Resume Guard claim.

### CodeGraph Guard v2

CodeGraph is preferred for repository discovery: finding symbols, implementations, callers, dependencies, and related files. `ls`, known-file reads, and command-output filtering such as `npx vitest run | grep failed` are allowed. Before CodeGraph orientation, broad direct `rg`, `find`, and recursive `grep` searches may be guarded. A CodeGraph tool attempt permits focused fallback discovery for that agent turn. This is workflow guidance, not a security boundary or a complete shell parser.

### Lifecycle coordination

The supervisor allows one live transition at a time and suppresses duplicate `/handoff` and `/new-handoff` requests. Cancellation invalidates pending asynchronous lifecycle work. Recovery Mode suppresses normal supervisor transitions. Pi's intentional fresh-session shutdown is recorded as clean so it is not mistaken for a crash.

## Requirements and compatibility

The supported Pi range is **`>=0.99.2 <0.100.0`**. The extension lifecycle APIs were validated against Pi 0.99.2; future `0.x` minor versions are not assumed compatible automatically. Run `pi-handoff doctor` to check the installed version and project setup. Versions inside the declared range are accepted by the compatibility check, but that does not mean each patch release was individually exercised.

`pi-handoff` does not own Pi core. It does not automatically upgrade or downgrade Pi. If the installed Pi version is unsupported or cannot be verified, startup stops before lifecycle state is changed.

The CLI requires Node.js `>=22.6`. Pi and CodeGraph must be available. `init --install-tools` installs missing CLIs only when explicitly requested: Pi is pinned to 0.99.2 and CodeGraph CLI to 1.6.1. It does not replace an already-installed unsupported Pi. The CodeGraph Pi extension is registered as `@izhimu/pi-codegraph@0.3.0` when needed.

## Install for local development

The package is prepared for release but is not documented as a published npm installation. Clone the confirmed repository and install its development dependencies:

```bash
git clone https://github.com/arieltoledo/pi-handoff.git
cd pi-handoff
npm install
```

Run the CLI from the checkout (or link it into your PATH using your preferred local workflow):

```bash
node /path/to/pi-handoff/bin/pi-handoff.js init --cwd /path/to/project
```

If Pi or CodeGraph is missing, install missing tools explicitly:

```bash
node /path/to/pi-handoff/bin/pi-handoff.js init --cwd /path/to/project --install-tools
```

## Normal workflow

```text
pi-handoff init
       ↓
pi-handoff doctor
       ↓
pi-handoff start
       ↓
agent works within Authorized Scope
       ↓
semantic handoff when needed
       ↓
fresh session verifies project state
       ↓
continue authorized IN_PROGRESS work, or wait for the user
```

A model may request a handoff after a meaningful unit of work. The supervisor waits until Pi reaches a safe boundary, prepares `.agent/HANDOFF.md`, validates that it changed, then requests a fresh session. `COMPLETE`, `BLOCKED`, and `AWAITING_USER` sessions verify the checkpoint and wait; only `IN_PROGRESS` may continue, once, and only within its Authorized Scope.

## Commands

### `pi-handoff init [--cwd DIR] [--install-tools] [--dry-run]`

Prepares the project: registers the local pi-handoff package and CodeGraph extension as needed, initializes the CodeGraph index, creates `.agent/HANDOFF.md`, merges managed lifecycle instructions into `AGENTS.md`, configures `.pi/settings.json`, and excludes legacy global extension copies in the project. It is intended to be idempotent. `--install-tools` installs missing pinned tools; it never replaces an installed unsupported Pi.

### `pi-handoff doctor [--cwd DIR]`

Reports project health and Pi compatibility, including the installed version and supported range. Returns nonzero when required checks fail or Pi is incompatible/unverifiable.

### `pi-handoff status [--cwd DIR]`

Reports project health, Pi compatibility, and CodeGraph status when the CLI and index are available.

### `pi-handoff update [--cwd DIR] [--dry-run]`

Updates configured pi-handoff and CodeGraph Pi package integrations when applicable. For a local checkout, changes are available after Pi restarts or `/reload`. This command does **not** update Pi core.

### `pi-handoff start [--cwd DIR] [--dry-run] [-- PI OPTIONS]`

Runs compatibility and project preflight checks, syncs CodeGraph, then starts Pi. Startup selects Recovery Mode when an active crash journal exists; otherwise it applies normal HANDOFF semantics and the Resume Guard. Compatibility rejection occurs before CodeGraph sync, Recovery mutation, Resume Guard consumption, or Pi launch.

Pass Pi options after `--`, for example:

```bash
pi-handoff start -- --help
```

## Project-local files

An initialized project may contain:

| Path | Purpose |
| --- | --- |
| `.agent/HANDOFF.md` | Human-readable semantic checkpoint and authorization scope. |
| `.agent/RECOVERY.json` | Incremental crash journal; active status signals unexpected termination. |
| `.agent/RECOVERY.last-crash.json` | Preserved crash evidence for diagnosis. |
| `.agent/HANDOFF.resume.json` | Human-readable summary of the most recently claimed IN_PROGRESS checkpoint. |
| `.agent/HANDOFF.resume.claims/` | Atomic per-fingerprint Resume Guard claims. |
| `.codegraph/` | Generated CodeGraph index. |
| `.pi/settings.json` | Project-local Pi package and extension configuration. |
| `AGENTS.md` | Project instructions with a managed pi-handoff lifecycle section. |

These artifacts belong to the project. `.agent/`, `.codegraph/`, and `.pi/` are ignored by this repository's own `.gitignore`; an initialized user's repository manages them according to that project's Git policy.

## Ownership boundaries

`pi-handoff` owns its extension package, lifecycle coordination, and project metadata it creates or manages. It does not own Pi core, CodeGraph core, application source code, or Git history. It does not patch or copy Pi internals, and it leaves legacy global extension files intact; initialized projects exclude those files where appropriate to prevent duplicate handlers.

## Development and validation

```bash
npm install
npm test
npm run typecheck
```

The automated suite exercises lifecycle behavior with deterministic extension and CLI harnesses. A real Pi run is still useful for validating host event ordering and session replacement.

## License

MIT. See [LICENSE](LICENSE).
