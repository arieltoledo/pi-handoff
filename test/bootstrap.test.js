import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { mergeAgents, packageRoot } from '../lib/cli.js';
import {
  fingerprint,
  getWorkStatus,
  isLegacyHandoff,
  validateHandoff,
} from '../lib/handoff.js';
import { readResumeGuard } from '../lib/resume-guard.js';

test('managed AGENTS block preserves unrelated user text and is idempotent', () => {
  const fragment = '<!-- pi-handoff:start -->\nnew rules\n<!-- pi-handoff:end -->';
  const source = 'User instructions\n\n<!-- pi-handoff:start -->\nold rules\n<!-- pi-handoff:end -->\nTrailing instructions\n';
  const merged = mergeAgents(source, fragment);
  assert.match(merged, /^User instructions/);
  assert.match(merged, /Trailing instructions\n$/);
  assert.equal(mergeAgents(merged, fragment), merged);
  assert.throws(() => mergeAgents('<!-- pi-handoff:start -->', fragment), /malformed/);
});
test('handoff rejects absent, partial and empty sections', async () => {
  const valid = await readFile(join(packageRoot, 'resources/HANDOFF.template.md'), 'utf8');
  assert.equal(validateHandoff(valid), null);
  assert.ok(validateHandoff(null));
  assert.ok(validateHandoff(valid.replace('## Tests', '## Other')));
  assert.ok(validateHandoff(valid.replace(/## Next Step[\s\S]*/, '## Next Step\n')));
  assert.notEqual(fingerprint(valid), fingerprint(valid + '\nVerified today.'));
});

test('handoff v2 validates work status and preserves legacy compatibility', async () => {
  const valid = await readFile(
    join(packageRoot, 'resources/HANDOFF.template.md'),
    'utf8',
  );

  assert.equal(isLegacyHandoff(valid), false);
  assert.equal(getWorkStatus(valid), 'AWAITING_USER');

  const withStatus = status =>
    valid.replace(
      /(## Work Status\s*\n)[^\n]+/,
      `$1${status}`,
    );

  for (const status of [
    'IN_PROGRESS',
    'COMPLETE',
    'BLOCKED',
    'AWAITING_USER',
  ]) {
    assert.equal(
      validateHandoff(withStatus(status)),
      null,
      `expected ${status} to be valid`,
    );

    assert.equal(
      getWorkStatus(withStatus(status)),
      status,
    );
  }

  const invalidStatus =
    withStatus('RUNNING');

  assert.match(
    validateHandoff(invalidStatus),
    /Invalid Work Status/,
  );

  assert.equal(
    getWorkStatus(invalidStatus),
    null,
  );

  const partialV2 =
    valid.replace(
      '## Authorized Scope',
      '## Removed Authorized Scope',
    );

  assert.match(
    validateHandoff(partialV2),
    /Authorized Scope/,
  );

  const legacy = `# Session Handoff

## Current Goal
Continue the authorized task.

## Completed
Initial implementation completed.

## Decisions
Keep the implementation minimal.

## Files Changed
app.py

## Tests
Tests not yet run.

## Current State
Work remains incomplete.

## Blockers
None.

## Next Step
Finish the remaining authorized work.
`;

  assert.equal(
    isLegacyHandoff(legacy),
    true,
  );

  assert.equal(
    getWorkStatus(legacy),
    null,
  );

  assert.equal(
    validateHandoff(legacy),
    null,
  );
});

test('bootstrap installs once, preserves files/settings, excludes legacy and start checks errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-handoff-test-'));
  const repo = join(root, 'repo'), bin = join(root, 'bin'), agent = join(root, 'agent');
  await Promise.all([mkdir(join(repo, '.pi'), { recursive: true }), mkdir(bin), mkdir(join(agent, 'extensions'), { recursive: true })]);
  await writeFile(join(agent, 'extensions/handoff.ts'), '// original');
  await writeFile(join(repo, '.pi/settings.json'), JSON.stringify({ theme: 'user-theme', packages: [], extensions: ['custom.ts'] }));
  await writeFile(join(repo, 'AGENTS.md'), 'Existing user rules\n');
  const log = join(root, 'calls');
  await writeFile(join(bin, 'pi'), `#!/usr/bin/env node\nconst fs=require('fs'); const a=process.argv.slice(2); if(a[0]==='--version'){console.log('0.99.2');process.exit(0)} fs.appendFileSync(process.env.CALL_LOG,'pi '+JSON.stringify(a)+'\\n'); if(a[0]==='install'){const p='.pi/settings.json'; const s=JSON.parse(fs.readFileSync(p));s.packages.push(a[1]);fs.writeFileSync(p,JSON.stringify(s));}`, { mode: 0o755 });
  await writeFile(join(bin, 'codegraph'), `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('1.6.1');process.exit(0)}fs.appendFileSync(process.env.CALL_LOG,'cg '+JSON.stringify(a)+'\\n');if(a[0]==='init')fs.mkdirSync('.codegraph',{recursive:true});if(a[0]==='sync'&&process.env.FAIL_SYNC)process.exit(1);`, { mode: 0o755 });
  const invoke = (args, overrides = {}) => spawnSync(process.execPath, [join(packageRoot, 'bin/pi-handoff.js'), ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agent, CALL_LOG: log, ...overrides } });
  assert.equal(invoke(['init', '--dry-run']).status, 0);
  assert.equal(JSON.parse(await readFile(join(repo, '.pi/settings.json'))).packages.length, 0);
  const first = invoke(['init']); assert.equal(first.status, 0, first.stderr);
  const handoff = await readFile(join(repo, '.agent/HANDOFF.md'), 'utf8');
  const second = invoke(['init']); assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(join(repo, '.agent/HANDOFF.md'), 'utf8'), handoff);
  const calls = await readFile(log, 'utf8');
  assert.equal(calls.split('\n').filter(line => line.startsWith('pi')).length, 2);
  assert.equal(calls.split('\n').filter(line => line.includes('init')).length, 1);
  const settings = JSON.parse(await readFile(join(repo, '.pi/settings.json')));
  assert.equal(settings.theme, 'user-theme');
  assert.ok(settings.extensions.includes('custom.ts'));
  assert.ok(settings.extensions.includes(`-${join(agent, 'extensions/handoff.ts')}`));
  assert.equal(await readFile(join(agent, 'extensions/handoff.ts'), 'utf8'), '// original');
  assert.match(await readFile(join(repo, 'AGENTS.md'), 'utf8'), /^Existing user rules/);

  assert.equal(invoke(['doctor']).status, 0);
  assert.equal(invoke(['start', '--dry-run']).status, 0);
  assert.equal(invoke(['start'], { FAIL_SYNC: '1' }).status, 1);

  /**
   * IN_PROGRESS start is one-shot.
   *
   * First start consumes the checkpoint and launches Pi normally.
   * A second start with the exact same HANDOFF must launch Pi in
   * RESUME GUARD mode instead of authorizing another continuation.
   */
  const inProgress = handoff.replace(
    /(## Work Status\s*\n)[^\n]+/,
    '$1IN_PROGRESS',
  );

  await writeFile(
    join(repo, '.agent/HANDOFF.md'),
    inProgress,
  );

  const firstResume = invoke(['start']);

  assert.equal(
    firstResume.status,
    0,
    firstResume.stderr,
  );

  const resumeState =
    await readResumeGuard(repo);

  assert.equal(
    resumeState?.consumed,
    true,
  );

  assert.equal(
    resumeState?.workStatus,
    'IN_PROGRESS',
  );

  assert.equal(
    resumeState?.source,
    'pi-handoff start',
  );

  const secondResume = invoke(['start']);

  assert.equal(
    secondResume.status,
    0,
    secondResume.stderr,
  );

  assert.match(
    secondResume.stdout,
    /RESUME GUARD: this IN_PROGRESS handoff has already been resumed/,
  );

  const callsAfterResume =
    await readFile(log, 'utf8');

  const lastPiCall =
    callsAfterResume
      .split('\n')
      .filter(line => line.startsWith('pi '))
      .at(-1);

  assert.match(
    lastPiCall,
    /RESUME GUARD/,
  );

  /**
 * Two concurrent CLI starts using the same fresh IN_PROGRESS
 * checkpoint must produce exactly one continuation and one
 * resume-guard rejection.
 */
const concurrentHandoff =
  `${inProgress}\n<!-- concurrent-start-test -->\n`;

await writeFile(
  join(repo, '.agent/HANDOFF.md'),
  concurrentHandoff,
);

const startConcurrent = () =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(packageRoot, 'bin/pi-handoff.js'),
        'start',
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PI_CODING_AGENT_DIR: agent,
          CALL_LOG: log,
        },
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on(
      'data',
      chunk => {
        stdout += chunk;
      },
    );

    child.stderr.on(
      'data',
      chunk => {
        stderr += chunk;
      },
    );

    child.on(
      'error',
      reject,
    );

    child.on(
      'close',
      status => {
        resolve({
          status,
          stdout,
          stderr,
        });
      },
    );
  });

const concurrentResults =
  await Promise.all([
    startConcurrent(),
    startConcurrent(),
  ]);

for (const result of concurrentResults) {
  assert.equal(
    result.status,
    0,
    result.stderr,
  );
}

const concurrentOutput =
  concurrentResults
    .map(result => result.stdout)
    .join('\n');

const consumeCount =
  (
    concurrentOutput.match(
      /RESUME GUARD: consuming IN_PROGRESS checkpoint/g,
    ) ?? []
  ).length;

const rejectCount =
  (
    concurrentOutput.match(
      /RESUME GUARD: this IN_PROGRESS handoff has already been resumed/g,
    ) ?? []
  ).length;

assert.equal(
  consumeCount,
  1,
  'exactly one concurrent CLI start must acquire the checkpoint',
);

assert.equal(
  rejectCount,
  1,
  'exactly one concurrent CLI start must be blocked by the resume guard',
);
  /**
   * Invalid handoffs are still rejected before Pi starts.
   */
  await writeFile(
    join(repo, '.agent/HANDOFF.md'),
    'bad handoff',
  );

    assert.equal(invoke(['start']).status, 1);
});
