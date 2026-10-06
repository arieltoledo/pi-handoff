# Changelog

Notable changes to pi-handoff are documented here.

## [0.2.0] - 2026-10-06

### Added

- HANDOFF v2 with persisted Authorized Scope, Work Status, and approval boundaries.
- Atomic one-shot Resume Guard claims for `IN_PROGRESS` checkpoints.
- Crash journaling and diagnosis-only Recovery Mode.
- Context-pressure handling during active agent work, with safe-boundary handoff.
- Pi compatibility diagnostics and an early startup compatibility gate.
- Lifecycle coordination that latches asynchronous handoff and reset transitions.
- Project licensed under the MIT License.

### Changed

- CodeGraph discovery guidance distinguishes repository searches from normal output filtering.
- Supervisor cancellation and Recovery Mode suppress conflicting automatic transitions.

### Fixed

- Duplicate continuation from the same `IN_PROGRESS` handoff fingerprint.
- False CodeGraph guard blocks on ordinary grep and command-output pipelines.
- Duplicate asynchronous handoff preparation and fresh-session requests from overlapping lifecycle events.
