import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';

import { join } from 'node:path';

const FILE = '.agent/HANDOFF.resume.json';
const CLAIMS_DIR = '.agent/HANDOFF.resume.claims';

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function claimPath(cwd, handoffFingerprint) {
  return join(
    cwd,
    CLAIMS_DIR,
    `${handoffFingerprint}.json`,
  );
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readResumeGuard(cwd) {
  return readJson(join(cwd, FILE));
}

export async function isResumeConsumed(
  cwd,
  handoffFingerprint,
) {
  /**
   * Per-fingerprint claim files are authoritative for the
   * atomic implementation.
   */
  if (
    await exists(
      claimPath(cwd, handoffFingerprint),
    )
  ) {
    return true;
  }

  /**
   * Backward compatibility with resume markers created
   * before atomic claims were introduced.
   */
  const state = await readResumeGuard(cwd);

  return (
    state?.version === 1 &&
    state?.handoffFingerprint === handoffFingerprint &&
    state?.consumed === true
  );
}

/**
 * Atomically claim an IN_PROGRESS handoff.
 *
 * Returns the new state when this caller successfully acquired
 * the checkpoint.
 *
 * Returns null when the exact fingerprint was already consumed.
 *
 * The per-fingerprint claim file is created with `wx`, so two
 * concurrent callers cannot both acquire the same checkpoint.
 */
export async function claimResume(
  cwd,
  handoffFingerprint,
  metadata = {},
) {
  const agentDir = join(cwd, '.agent');

  const claimsDir = join(
    cwd,
    CLAIMS_DIR,
  );

  const file = join(cwd, FILE);

  const claim = claimPath(
    cwd,
    handoffFingerprint,
  );

  await mkdir(agentDir, {
    recursive: true,
  });

  await mkdir(claimsDir, {
    recursive: true,
  });

  /**
   * Respect markers created by the pre-atomic implementation.
   */
  const previous = await readResumeGuard(cwd);

  if (
    previous?.version === 1 &&
    previous?.handoffFingerprint === handoffFingerprint &&
    previous?.consumed === true
  ) {
    return null;
  }

  const state = {
    ...metadata,

    // Resume-guard invariants.
    version: 1,
    handoffFingerprint,
    consumed: true,
    consumedAt: new Date().toISOString(),
  };

  /**
   * Atomic acquisition point.
   *
   * Exactly one caller can create this file.
   */
  try {
    await writeFile(
      claim,
      `${JSON.stringify(state, null, 2)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
      },
    );
  } catch (error) {
    if (error.code === 'EEXIST') {
      return null;
    }

    throw error;
  }

  /**
   * HANDOFF.resume.json is the human-readable summary of the
   * most recently consumed checkpoint.
   */
  const temp =
    `${file}.${process.pid}.tmp`;

  try {
    await writeFile(
      temp,
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    );

    await rename(
      temp,
      file,
    );
  } catch (error) {
    /**
     * We acquired the claim but failed to persist its summary.
     * Release the claim so the checkpoint can be retried.
     */
    await rm(claim, {
      force: true,
    });

    await rm(temp, {
      force: true,
    });

    throw error;
  }

  return state;
}

/**
 * Compatibility wrapper.
 *
 * Existing callers still use consumeResume(). They will be
 * migrated to claimResume() so they can distinguish successful
 * acquisition from an already-consumed checkpoint.
 */
export async function consumeResume(
  cwd,
  handoffFingerprint,
  metadata = {},
) {
  return claimResume(
    cwd,
    handoffFingerprint,
    metadata,
  );
}

/**
 * Release a consumed checkpoint when session creation was
 * explicitly cancelled or failed before continuation began.
 */
export async function releaseResume(
  cwd,
  handoffFingerprint,
) {
  const file = join(cwd, FILE);
  const claim = claimPath(
    cwd,
    handoffFingerprint,
  );

  const state =
    await readResumeGuard(cwd);

  const claimed =
    await exists(claim);

  if (
    !claimed &&
    !(
      state?.version === 1 &&
      state?.handoffFingerprint === handoffFingerprint
    )
  ) {
    return false;
  }

  await rm(claim, {
    force: true,
  });

  /**
   * Remove the summary only if it still refers to this
   * checkpoint. Never erase a newer checkpoint's state.
   */
  if (
    state?.version === 1 &&
    state?.handoffFingerprint === handoffFingerprint
  ) {
    await rm(file, {
      force: true,
    });
  }

  return true;
}
