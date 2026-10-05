# Session Handoff

## User Request
No task has been assigned yet.

## Authorized Scope
No implementation work is currently authorized.

The agent may inspect repository state when necessary to understand the project,
but must not modify application code until the user provides a task and
explicitly authorizes the relevant scope.

## Work Status
AWAITING_USER

Allowed values:

- `IN_PROGRESS` — authorized work is still incomplete and may continue in a fresh session.
- `COMPLETE` — the authorized work unit is finished. Do not begin follow-up work automatically.
- `BLOCKED` — authorized work cannot continue until a blocker is resolved.
- `AWAITING_USER` — no work should continue until the user provides a new instruction or approval.

## Current Goal
No active implementation goal.

## Completed
Project bootstrap created the initial handoff.

## Decisions
- Repository files and Git state are the source of truth.
- A recommended future action is not authorization to perform it.
- `Next Step` must always remain inside `Authorized Scope`.
- Work outside `Authorized Scope` belongs under `Requires User Approval`.

## Files Changed
Bootstrap metadata only; inspect actual repository state before relying on this section.

## Tests
No application tests have been run by the bootstrap.

## Current State
Initial handoff. Implementation status has not yet been assessed.

## Blockers
None recorded.

## Next Step
Ask the user what they want to work on.

Do not modify application code until a new task and its authorized scope are clear.

## Requires User Approval
Any implementation, refactor, migration, bug fix, feature, or other repository
modification not explicitly authorized by the current user request.
