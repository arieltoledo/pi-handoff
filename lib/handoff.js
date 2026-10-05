import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const workStatuses = [
  'IN_PROGRESS',
  'COMPLETE',
  'BLOCKED',
  'AWAITING_USER',
];

export const policySections = [
  'User Request',
  'Authorized Scope',
  'Work Status',
  'Requires User Approval',
];

export const legacySections = [
  'Current Goal',
  'Completed',
  'Decisions',
  'Files Changed',
  'Tests',
  'Current State',
  'Blockers',
  'Next Step',
];

export const sections = [
  'User Request',
  'Authorized Scope',
  'Work Status',
  'Current Goal',
  'Completed',
  'Decisions',
  'Files Changed',
  'Tests',
  'Current State',
  'Blockers',
  'Next Step',
  'Requires User Approval',
];

export async function readHandoff(cwd) {
  try {
    return await readFile(
      join(cwd, '.agent', 'HANDOFF.md'),
      'utf8'
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function fingerprint(text) {
  return text === null
    ? null
    : createHash('sha256')
        .update(text)
        .digest('hex');
}

function headings(text) {
  return [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
}

export function readSection(text, section) {
  if (!text) return null;

  const matches = headings(text);
  const index = matches.findIndex(
    match => match[1] === section
  );

  if (index < 0) return null;

  const start =
    matches[index].index +
    matches[index][0].length;

  const end =
    matches[index + 1]?.index ??
    text.length;

  const value =
    text.slice(start, end).trim();

  return value || null;
}

export function isLegacyHandoff(text) {
  if (!text?.trim()) return false;

  return policySections.every(
    section => readSection(text, section) === null
  );
}

export function getWorkStatus(text) {
  const value =
    readSection(text, 'Work Status');

  if (!value) return null;

  const firstLine =
    value
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);

  if (!firstLine) return null;

  return workStatuses.includes(firstLine)
    ? firstLine
    : null;
}

function validateSections(text, required) {
  for (const section of required) {
    const value = readSection(text, section);

    if (value === null) {
      return `Missing or empty section: ${section}`;
    }
  }

  return null;
}

export function validateHandoff(text) {
  if (!text?.trim()) {
    return 'HANDOFF.md is missing or empty';
  }

  /**
   * Backward-compatible transition.
   *
   * Existing repositories may still contain the v1 handoff.
   * We allow it to load so pi-handoff does not strand those
   * repositories.
   *
   * resumePrompt treats a legacy handoff conservatively as
   * AWAITING_USER, so it cannot authorize implementation.
   *
   * The next /handoff invocation upgrades it to v2.
   */
  if (isLegacyHandoff(text)) {
    return validateSections(
      text,
      legacySections
    );
  }

  /**
   * If any policy metadata exists, require the complete
   * v2 contract.
   */
  const missing = validateSections(
    text,
    sections
  );

  if (missing) return missing;

  const status = getWorkStatus(text);

  if (!status) {
    return (
      'Invalid Work Status. Expected one of: ' +
      workStatuses.join(', ')
    );
  }

  return null;
}

export const preparePrompt = `
Prepare a session handoff.

Use CodeGraph first for repository orientation and verify actual
on-disk state. Use Git status/diff when Git is available.

Update .agent/HANDOFF.md to the current v2 handoff format.

The file MUST contain these nonempty sections, in this order:

${sections.map(section => `## ${section}`).join('\n')}

Follow these rules carefully:

USER REQUEST

Record the actual user-authorized objective for the current work unit.

Do not replace it with:
- your own roadmap;
- a recommended follow-up;
- a logical next migration stage;
- work you think should happen later.

AUTHORIZED SCOPE

Record what the current user request actually permits.

Be explicit about important restrictions such as:
- files or areas that may be changed;
- audit-only or read-only work;
- stages that are authorized;
- stages that are explicitly not authorized;
- whether application code may be modified.

Never infer authorization merely because a follow-up would be useful.

WORK STATUS

Use exactly one of:

IN_PROGRESS
COMPLETE
BLOCKED
AWAITING_USER

Meaning:

IN_PROGRESS
Authorized work remains unfinished and may continue in a fresh session.

COMPLETE
The currently authorized work unit is finished.
A fresh session must not automatically begin follow-up work.

BLOCKED
Authorized work cannot proceed until a blocker is resolved.

AWAITING_USER
No implementation should continue until the user provides a new
instruction or explicit approval.

CURRENT GOAL

Describe the immediate goal inside the Authorized Scope.

COMPLETED

Record only work that is actually complete and verified.

DECISIONS

Preserve architectural, implementation, workflow, and scope decisions
that must survive the session boundary.

FILES CHANGED

Record files actually changed and the purpose of those changes.

TESTS

Record commands actually run and their real results.

Never invent successful validation.

CURRENT STATE

Describe the repository state required for safe continuation.

Repository files and Git are authoritative.

BLOCKERS

Record only real unresolved blockers.
Use "None" when there are none.

NEXT STEP

The Next Step MUST remain inside Authorized Scope.

Important:

Next Step is NOT authorization.

If Work Status is COMPLETE or AWAITING_USER, Next Step should normally
be to wait for the user's next instruction or approval.

Do not put an unauthorized future migration stage here as an executable
instruction.

REQUIRES USER APPROVAL

Record useful or logical follow-up work that is outside the currently
Authorized Scope.

Examples:
- next migration stage;
- unrelated refactor;
- publishing;
- destructive operation;
- behavior change not requested by the user.

Use "None" only when there is genuinely no known follow-up requiring
new authorization.

GENERAL RULES

- If the existing handoff uses the legacy format, upgrade it to v2.
- Do not modify application code while preparing the handoff.
- Run relevant tests only when their current status is uncertain.
- Do not omit unfinished work.
- Keep the handoff concise and operational.
- A recommended next action is never permission to execute it.
- Refresh the handoff even if only verification metadata changed.

Finish by confirming HANDOFF.md is ready for a fresh session.
`.trim();

export const resumePrompt = `
Read .agent/HANDOFF.md first.

Before modifying anything:

1. Identify User Request.
2. Identify Authorized Scope.
3. Identify Work Status.
4. Verify current repository state with Git when available.
5. Use CodeGraph for repository orientation when needed.
6. Treat repository files as authoritative if they conflict with
   HANDOFF.md.

SESSION AUTHORIZATION RULES

If the handoff is in the legacy format and does not contain:
- User Request
- Authorized Scope
- Work Status
- Requires User Approval

then treat it as:

Work Status = AWAITING_USER

Verify and summarize the repository state, then wait for the user.
Do not continue implementation from a legacy Next Step.

If Work Status = IN_PROGRESS:

- You may continue the unfinished work.
- Continue only inside Authorized Scope.
- Start from the safest relevant Next Step.
- Do not expand into work listed under Requires User Approval.
- Do not interpret roadmap ordering as authorization.

If Work Status = COMPLETE:

- Verify the recorded state when necessary.
- Summarize that the authorized work is complete.
- Do not begin the next feature, stage, refactor, or recommendation.
- Wait for the user's next instruction.

If Work Status = BLOCKED:

- Verify whether the blocker still exists.
- Report the blocker.
- Do not work around it by expanding scope.
- Wait for the information or authorization needed from the user.

If Work Status = AWAITING_USER:

- Do not modify application code.
- Briefly summarize the current state.
- Wait for a new user instruction or approval.

GLOBAL RULES

- Next Step is not authorization.
- Requires User Approval is explicitly outside the current scope.
- Do not rely on previous conversation history.
- Do not repeat completed work.
- Keep context focused and operational.
`.trim();
