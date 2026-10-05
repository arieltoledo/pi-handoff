import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RECOVERY_FILE = '.agent/RECOVERY.json';
const LAST_CRASH_FILE = '.agent/RECOVERY.last-crash.json';

export async function readRecovery(repo) {
  const file = join(repo, RECOVERY_FILE);

  try {
    const raw = await readFile(file, 'utf8');
    const recovery = JSON.parse(raw);

    if (
      recovery === null ||
      typeof recovery !== 'object' ||
      recovery.version !== 1
    ) {
      throw new Error('unsupported or malformed recovery journal');
    }

    return recovery;
  } catch (error) {
    if (error.code === 'ENOENT') return null;

    throw new Error(
      `Cannot read ${file}: ${error.message}`
    );
  }
}

export function needsCrashRecovery(recovery) {
  return recovery?.status === 'active';
}

/**
 * Preserve the crashed session journal before Pi starts.
 *
 * The recovery extension will overwrite RECOVERY.json as soon
 * as the new agent receives its first prompt, so the crash
 * evidence must be copied first.
 */
export async function preserveCrashRecovery(repo) {
  const source = join(repo, RECOVERY_FILE);
  const destination = join(repo, LAST_CRASH_FILE);

  await copyFile(source, destination);

  return LAST_CRASH_FILE;
}

export function recoveryPrompt(recovery) {
  const session =
    recovery?.sessionId ?? 'unknown';

  const request =
    recovery?.userRequest ?? 'unknown';

  const tool =
    recovery?.currentTool?.name ?? 'unknown';

  const started =
    recovery?.currentTool?.startedAt ?? 'unknown';

  return `
RECOVERY MODE

The previous Pi session ended unexpectedly.

Previous session:
${session}

Original user request:
${request}

An unfinished tool call was recorded:

Tool: ${tool}
Started: ${started}

The complete crash journal was preserved at:

.agent/RECOVERY.last-crash.json

Before doing anything else:

1. Read .agent/RECOVERY.last-crash.json.
2. Read .agent/HANDOFF.md as the last clean semantic checkpoint.
   HANDOFF.md may be older than the interrupted work.
3. Inspect git status and git diff when Git is available.
4. Use CodeGraph to orient yourself in the current repository.
5. Inspect any file that may have been affected by the unfinished tool.
6. Determine whether tests or validation results are still trustworthy.

Repository state and on-disk files are authoritative.

IMPORTANT:

- The tool recorded as currentTool was started but no tool_result
  was recorded.
- Treat that operation as potentially incomplete.
- Do NOT replay the interrupted tool.
- Do NOT modify files.
- Do NOT run commands that may change repository or external state.
- Do NOT continue implementation.
- Do NOT expand the scope of the original user request.
- A suggested future step is not authorization to perform it.

Your job in RECOVERY MODE is diagnosis only.

Reconstruct and report:

1. Original task
   - What the user had asked for.

2. Last clean checkpoint
   - What HANDOFF.md says was definitely complete.

3. Interrupted operation
   - Which tool was running.
   - What it was attempting to do.
   - What may therefore be incomplete or uncertain.

4. Current repository state
   - Git status/diff when available.
   - Relevant files and CodeGraph state.
   - Whether the working tree appears consistent.

5. Validation state
   - Which tests were definitely completed before the crash.
   - Which tests or checks may need to be rerun.

6. Safest recovery point
   - Identify the smallest safe point from which work could resume.

Then STOP.

Ask the user how they want to proceed.

When appropriate, offer these options:

1. Resume from the safest recovered point.
2. Inspect the current changes before continuing.
3. Return to the last clean checkpoint.
4. Discard the interrupted task and start fresh.

Do not execute any of those options until the user explicitly chooses one.

Do not rely on previous conversation history.
`.trim();
}

