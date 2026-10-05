import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mkdtemp,
  readFile,
} from 'node:fs/promises';

import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  claimResume,
  consumeResume,
  isResumeConsumed,
  readResumeGuard,
  releaseResume,
} from '../lib/resume-guard.js';

test('resume guard consumes an IN_PROGRESS checkpoint once', async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), 'pi-handoff-resume-'),
  );

  const fingerprint = 'checkpoint-abc';

  assert.equal(
    await isResumeConsumed(cwd, fingerprint),
    false,
  );

  await consumeResume(
    cwd,
    fingerprint,
    {
      workStatus: 'IN_PROGRESS',
      source: 'test',
    },
  );

  assert.equal(
    await isResumeConsumed(cwd, fingerprint),
    true,
  );

  const state = await readResumeGuard(cwd);

  assert.equal(state.version, 1);
  assert.equal(
    state.handoffFingerprint,
    fingerprint,
  );
  assert.equal(state.consumed, true);
  assert.equal(
    state.workStatus,
    'IN_PROGRESS',
  );
  assert.equal(state.source, 'test');
  assert.ok(state.consumedAt);
});

test('a different handoff fingerprint is not considered consumed', async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), 'pi-handoff-resume-'),
  );

  await consumeResume(
    cwd,
    'checkpoint-one',
    {
      workStatus: 'IN_PROGRESS',
    },
  );

  assert.equal(
    await isResumeConsumed(
      cwd,
      'checkpoint-one',
    ),
    true,
  );

  assert.equal(
    await isResumeConsumed(
      cwd,
      'checkpoint-two',
    ),
    false,
  );
});

test('release removes only the matching consumed checkpoint', async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), 'pi-handoff-resume-'),
  );

  await consumeResume(
    cwd,
    'checkpoint-one',
    {
      workStatus: 'IN_PROGRESS',
    },
  );

  assert.equal(
    await releaseResume(
      cwd,
      'checkpoint-other',
    ),
    false,
  );

  assert.equal(
    await isResumeConsumed(
      cwd,
      'checkpoint-one',
    ),
    true,
  );

  assert.equal(
    await releaseResume(
      cwd,
      'checkpoint-one',
    ),
    true,
  );

  assert.equal(
    await isResumeConsumed(
      cwd,
      'checkpoint-one',
    ),
    false,
  );
});

test('resume guard persists valid JSON on disk', async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), 'pi-handoff-resume-'),
  );

  await consumeResume(
    cwd,
    'checkpoint-json',
    {
      workStatus: 'IN_PROGRESS',
    },
  );

  const raw = await readFile(
    join(
      cwd,
      '.agent',
      'HANDOFF.resume.json',
    ),
    'utf8',
  );

  const parsed = JSON.parse(raw);

  assert.equal(
    parsed.handoffFingerprint,
    'checkpoint-json',
  );

  assert.equal(
    parsed.consumed,
    true,
  );
});
test('concurrent resume claims allow exactly one winner', async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), 'pi-handoff-resume-'),
  );

  const fingerprint = 'checkpoint-race';

  const results = await Promise.all([
    claimResume(
      cwd,
      fingerprint,
      {
        workStatus: 'IN_PROGRESS',
        contender: 'one',
      },
    ),

    claimResume(
      cwd,
      fingerprint,
      {
        workStatus: 'IN_PROGRESS',
        contender: 'two',
      },
    ),
  ]);

  const winners = results.filter(
    result => result !== null,
  );

  const losers = results.filter(
    result => result === null,
  );

  assert.equal(
    winners.length,
    1,
    'exactly one concurrent caller must acquire the checkpoint',
  );

  assert.equal(
    losers.length,
    1,
    'exactly one concurrent caller must be rejected',
  );

  assert.equal(
    winners[0].handoffFingerprint,
    fingerprint,
  );

  assert.equal(
    await isResumeConsumed(
      cwd,
      fingerprint,
    ),
    true,
  );
});
