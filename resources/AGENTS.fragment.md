<!-- pi-handoff:start -->
## Pi session lifecycle

- Read `.agent/HANDOFF.md` at the beginning of a fresh session. Verify its claims against current files and Git status/diff when available.
- Use `codegraph_explore` before broad repository discovery. If CodeGraph fails or is insufficient, use focused reads and searches.
- Continue from the recorded Next Step; do not repeat verified completed work.
- After a complete semantic unit of work, call `request_handoff` with a concise reason. For context pressure, record unfinished work accurately before resetting.
- `/handoff` prepares the handoff; `/new-handoff` starts a fresh session from it. `/supervisor-status` reports progress and `/supervisor-cancel` cancels a pending reset.
- Keep the handoff concise: Current Goal, Completed, Decisions, Files Changed, Tests, Current State, Blockers, Next Step. Never claim unexecuted tests passed.
<!-- pi-handoff:end -->
