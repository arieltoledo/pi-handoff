# pi-handoff

Persistent, crash-aware session handoff and context management for the Pi Coding Agent.

`pi-handoff` helps long-running coding agents work across multiple fresh Pi sessions without depending on an ever-growing conversation history.

Instead of treating the conversation as the source of truth, it keeps the important working state inside the repository and reconstructs context from:

- the repository itself;
- Git state;
- CodeGraph;
- `.agent/HANDOFF.md`;
- `.agent/RECOVERY.json` after an unexpected crash.

The goal is simple:

> Preserve project state, not conversations.

---

## Why pi-handoff?

Long coding-agent sessions eventually accumulate large amounts of context.

This creates several problems:

- repeated file reads;
- stale assumptions about repository state;
- expensive context growth;
- native context compaction;
- degraded reasoning over long sessions;
- difficulty recovering after crashes;
- accidental continuation beyond the user's authorized scope.

`pi-handoff` introduces explicit session lifecycle management around Pi.

A typical workflow becomes:

```text
User task
   ↓
Pi + CodeGraph
   ↓
implementation
   ↓
tests / validation
   ↓
semantic checkpoint
   ↓
HANDOFF.md
   ↓
fresh Pi session
   ↓
repository + handoff + CodeGraph
   ↓
continue
```

If Pi crashes unexpectedly:

```text
working session
   ↓
RECOVERY.json
   ↓
unexpected termination
   ↓
pi-handoff start
   ↓
Recovery Mode
   ↓
inspect repository + crash journal
   ↓
ask the user how to continue
```

---

# Features

## Semantic session handoff

The agent can request a clean handoff after completing a meaningful unit of work such as:

- a feature;
- a bug fix;
- a refactor;
- a migration stage;
- another verified checkpoint.

The supervisor waits until the current Pi run is fully settled before preparing the handoff.

---

## Fresh-session continuation

A completed handoff starts a new Pi session rather than continuing indefinitely in the old conversation.

The fresh session reconstructs its working context using:

```text
.agent/HANDOFF.md
+ repository state
+ Git
+ CodeGraph
```

This allows old conversational context to become disposable.

---

## Context-pressure handoff

Long-running work can also trigger a preventive handoff when context usage becomes too high.

Semantic checkpoints are preferred, while context pressure acts as a safety mechanism for unusually long tasks.

---

## Crash Recovery

`pi-handoff` maintains a crash journal:

```text
.agent/RECOVERY.json
```

During agent execution it records information such as:

- Pi session ID;
- original user request;
- current status;
- context utilization;
- current tool call;
- last completed tool call;
- timestamps.

Example:

```json
{
  "version": 1,
  "status": "active",
  "userRequest": "Refactor the runtime provider layer",
  "currentTool": {
    "name": "write",
    "startedAt": "2026-10-04T23:42:29.141Z"
  }
}
```

A normal Pi shutdown changes the journal to:

```json
{
  "status": "clean",
  "shutdownReason": "quit"
}
```

If Pi is killed or the machine stops before shutdown, the journal remains:

```json
{
  "status": "active"
}
```

`pi-handoff start` detects this state automatically.

Before starting the new recovery session, the crash evidence is preserved as:

```text
.agent/RECOVERY.last-crash.json
```

---

## Assisted Recovery Mode

Crash recovery is intentionally conservative.

After an unexpected termination, the new agent does **not** automatically replay the interrupted operation or continue modifying the repository.

Instead it:

1. reads the crash journal;
2. reads the last clean handoff;
3. inspects Git state when available;
4. uses CodeGraph to inspect the repository;
5. identifies potentially incomplete work;
6. evaluates which previous validation results are still trustworthy;
7. reports the safest recovery point;
8. asks the user how to proceed.

Typical options are:

```text
1. Resume from the safest recovered point.
2. Inspect the current changes first.
3. Return to the last clean checkpoint.
4. Discard the interrupted task and start fresh.
```

No recovery action is executed until the user chooses.

---

## CodeGraph integration

`pi-handoff` integrates with:

```text
@izhimu/pi-codegraph
```

CodeGraph is used for semantic repository discovery, including:

- symbols;
- dependencies;
- callers;
- tests;
- blast radius;
- current source.

The integration also keeps the CodeGraph index synchronized after source edits.

Traditional shell tools remain available as fallback mechanisms.

---

# Installation

## Requirements

The currently tested stack includes:

```text
Pi Coding Agent 0.99.2
CodeGraph CLI 1.6.1
@izhimu/pi-codegraph 0.3.x
Node.js
```

A local LLM is optional.

`pi-handoff` works with Pi's configured model/provider stack.

For example, the project has been tested with Pi connected to a local `llama.cpp` server running Qwen.

---

## Local development installation

Clone the repository:

```bash
git clone <repository-url>
cd pi-handoff
npm install
```

From another project:

```bash
cd ~/Development/my-project
pi-handoff init
```

If Pi or CodeGraph are missing:

```bash
pi-handoff init --install-tools
```

---

# Commands

## Initialize a repository

```bash
pi-handoff init
```

This prepares the current repository for managed Pi sessions.

It can:

- register the `pi-handoff` Pi package;
- install/register the CodeGraph Pi extension;
- initialize CodeGraph;
- create `.agent/HANDOFF.md`;
- merge lifecycle instructions into `AGENTS.md`;
- configure project-local Pi settings;
- exclude legacy global extension copies.

The operation is intended to be idempotent.

---

## Diagnose the environment

```bash
pi-handoff doctor
```

Example:

```text
Project: /home/user/Development/project

OK Node
OK Pi
OK CodeGraph
OK Handoff package (project)
OK CodeGraph extension
OK CodeGraph index
OK HANDOFF.md
OK AGENTS.md lifecycle rules
OK Legacy extensions excluded in this project
```

`llama-server` and Pi Llama configuration are informational checks and are not required for every Pi setup.

---

## Show project status

```bash
pi-handoff status
```

This also displays CodeGraph status when the index is available.

---

## Update integrations

```bash
pi-handoff update
```

Installed package integrations are updated when applicable.

When `pi-handoff` itself is installed from a local development path, edits to the local package become available after restarting Pi or running:

```text
/reload
```

---

## Start Pi

```bash
pi-handoff start
```

Normal startup:

```text
validate project
   ↓
sync CodeGraph
   ↓
read HANDOFF.md
   ↓
start Pi
```

Crash startup:

```text
validate project
   ↓
detect RECOVERY.json status=active
   ↓
preserve RECOVERY.last-crash.json
   ↓
sync CodeGraph
   ↓
start Pi in Recovery Mode
```

Additional Pi options may be passed after `--`:

```bash
pi-handoff start -- <PI OPTIONS>
```

---

# Repository files

A project initialized with `pi-handoff` may contain:

```text
project/
├── .agent/
│   ├── HANDOFF.md
│   ├── RECOVERY.json
│   └── RECOVERY.last-crash.json
│
├── .codegraph/
│
├── .pi/
│   └── settings.json
│
└── AGENTS.md
```

## HANDOFF.md

A semantic checkpoint intended for a fresh agent session.

It should describe information such as:

- current goal;
- completed work;
- important decisions;
- files changed;
- tests;
- current repository state;
- blockers;
- next safe action.

Future versions will strengthen explicit authorization fields such as:

```text
User Request
Authorized Scope
Work Status
Requires User Approval
```

---

## RECOVERY.json

A machine-oriented crash journal.

Unlike `HANDOFF.md`, it is updated incrementally while the agent is running.

Its purpose is not to describe the project elegantly; its purpose is to provide evidence after an abnormal termination.

---

# Pi extension architecture

`pi-handoff` ships its Pi extensions from:

```text
extensions/
├── index.ts
├── handoff.ts
├── session-supervisor.ts
├── codegraph-auto-sync.ts
├── codegraph-guard.ts
└── recovery.ts
```

`extensions/index.ts` is the package entrypoint that registers the individual extensions with Pi.

These files are owned by `pi-handoff`.

They are **not patches to Pi itself**.

---

# Pi ownership and upgrade policy

`pi-handoff` does not overwrite Pi core files.

The separation is intentional:

```text
Pi installation
    ↓
Pi public extension API
    ↓
pi-handoff package
    ↓
pi-handoff extensions
```

When Pi is upgraded:

1. Pi updates its own code.
2. `pi-handoff` remains a separate package.
3. Existing project configuration continues loading the package.
4. If Pi changes its extension API, a compatible `pi-handoff` release must adapt to that API.

`pi-handoff` should never solve Pi compatibility by copying patched Pi source files into this repository.

---

# Legacy global extensions

Early development versions used global files such as:

```text
~/.pi/agent/extensions/handoff.ts
~/.pi/agent/extensions/session-supervisor.ts
~/.pi/agent/extensions/codegraph-auto-sync.ts
~/.pi/agent/extensions/codegraph-guard.ts
~/.pi/agent/extensions/recovery.ts
```

They may still exist on a development machine.

Initialized repositories explicitly exclude these legacy files so that the package version is loaded only once.

This prevents duplicate event handlers such as:

```text
two tool_call listeners
two recovery writers
two session supervisors
```

The package version under:

```text
pi-handoff/extensions/
```

is the source of truth.

---

# Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run TypeScript validation:

```bash
npx tsc --noEmit
```

The project should keep lifecycle behavior covered by automated tests before publishing releases.

---

# Design principles

## Repository state is authoritative

The agent should prefer:

```text
Git
+ on-disk files
+ CodeGraph
```

over remembered conversational state.

---

## Preserve state, not conversation

A previous Pi conversation should not be required to continue development.

Important information belongs in project artifacts.

---

## Semantic checkpoints over arbitrary truncation

A clean feature boundary is preferable to cutting a session merely because it is old.

Context-pressure handoff exists as a fallback.

---

## Recovery is different from handoff

A normal handoff means the previous agent deliberately reached a stable checkpoint.

A crash means the previous operation may have ended at any point.

Therefore:

```text
normal handoff
→ continuation may be automatic

crash recovery
→ diagnosis first
→ user decides how to continue
```

---

## User authorization survives session boundaries

A recommended next step is not automatically permission to execute it.

Future lifecycle metadata should explicitly distinguish:

```text
what is complete
what is still authorized
what merely makes sense to do next
what requires new user approval
```

---

# Status

`pi-handoff` is currently under active development.

The current implementation has been validated with:

- semantic multi-session handoffs;
- CodeGraph-assisted repository navigation;
- context-aware session management;
- abrupt Pi termination using `SIGKILL`;
- persisted unfinished-tool recovery;
- fresh-session Recovery Mode;
- user-assisted recovery decisions.

It has also been exercised during a multi-stage real-world refactoring of a larger TypeScript repository rather than only on synthetic test projects.

---

# Roadmap

Near-term work includes:

- stronger scope and authorization persistence;
- context-pressure detection during the active agent loop;
- improved recovery metadata;
- package compatibility checks for Pi versions;
- reduced false positives in the CodeGraph discovery guard;
- automated lifecycle regression tests;
- published package installation and upgrade flow.

---

# License

Add the chosen project license here before public distribution.
