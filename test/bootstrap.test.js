import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
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
import { SUPPORTED_PI_RANGE } from '../lib/pi-compatibility.js';

const fakePiScript = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  const version = process.env.FAKE_PI_VERSION === undefined ? '0.99.2' : process.env.FAKE_PI_VERSION;
  if (version !== '__EMPTY__') console.log(version);
  process.exit(0);
}
fs.appendFileSync(process.env.CALL_LOG, 'pi ' + JSON.stringify(args) + '\\n');
if (args[0] === 'install') {
  const settingsPath = '.pi/settings.json';
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.packages.push(args[1]);
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
}
`;

async function compatibilityFixture({ withPi = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-handoff-compat-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const agent = join(root, 'agent');
  const log = join(root, 'calls.log');
  const piPath = join(bin, 'pi');
  await Promise.all([
    mkdir(join(repo, '.pi'), { recursive: true }),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);
  await writeFile(join(repo, '.pi/settings.json'), JSON.stringify({ packages: [], extensions: [] }));
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [] }));
  await writeFile(join(bin, 'codegraph'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.6.1'); process.exit(0); }
fs.appendFileSync(process.env.CALL_LOG, 'codegraph ' + JSON.stringify(args) + '\\n');
if (args[0] === 'init') fs.mkdirSync('.codegraph', { recursive: true });
`, { mode: 0o755 });
  await writeFile(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, 'npm ' + JSON.stringify(args) + '\\n');
if (args.some(arg => arg === '@earendil-works/pi-coding-agent@0.99.2')) {
  fs.writeFileSync(process.env.FAKE_PI_PATH, process.env.FAKE_PI_SCRIPT, { mode: 0o755 });
}
`, { mode: 0o755 });
  if (withPi) await writeFile(piPath, fakePiScript, { mode: 0o755 });

  const invoke = (args, overrides = {}) => spawnSync(
    process.execPath,
    [join(packageRoot, 'bin/pi-handoff.js'), ...args],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [bin, '/usr/bin', '/bin'].join(':'),
        PI_CODING_AGENT_DIR: agent,
        CALL_LOG: log,
        FAKE_PI_PATH: piPath,
        FAKE_PI_SCRIPT: fakePiScript,
        ...overrides,
      },
    },
  );
  const calls = async () => {
    try { return await readFile(log, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  const clearCalls = () => writeFile(log, '');
  const initialize = async () => {
    const result = invoke(['init']);
    assert.equal(result.status, 0, result.stderr);
    await clearCalls();
  };
  return { root, repo, bin, agent, log, piPath, invoke, calls, clearCalls, initialize };
}

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

test('doctor and status report supported Pi, and start follows the normal lifecycle', async () => {
  const h = await compatibilityFixture();
  await h.initialize();

  const doctor = h.invoke(['doctor']);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /OK Pi: 0\.99\.2/);
  assert.match(doctor.stdout, /OK Pi compatibility:.*supported/);
  assert.ok(doctor.stdout.includes(SUPPORTED_PI_RANGE));

  const status = h.invoke(['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Pi compatibility:.*supported/);

  await h.clearCalls();
  const start = h.invoke(['start']);
  assert.equal(start.status, 0, start.stderr);
  const calls = await h.calls();
  assert.match(calls, /codegraph \["sync"\]/);
  assert.match(calls, /^pi /m, 'Pi is launched after the compatibility check');
});

test('doctor and status distinguish unsupported or unverifiable installed Pi from missing Pi', async () => {
  const h = await compatibilityFixture();
  await h.initialize();

  const cases = [
    ['0.99.1', /UNSUPPORTED Pi compatibility:.*below supported range/],
    ['0.100.0', /UNSUPPORTED Pi compatibility:.*outside validated range/],
    ['something unexpected', /UNVERIFIED Pi compatibility:.*could not parse/],
  ];
  for (const [version, expected] of cases) {
    const doctor = h.invoke(['doctor'], { FAKE_PI_VERSION: version });
    assert.equal(doctor.status, 1, version);
    assert.match(doctor.stdout, new RegExp(`OK Pi: ${version.replaceAll('.', '\\.')}`));
    assert.doesNotMatch(doctor.stdout, /MISSING Pi:/);
    assert.match(doctor.stdout, expected);
    assert.ok(doctor.stdout.includes(SUPPORTED_PI_RANGE));

    const status = h.invoke(['status'], { FAKE_PI_VERSION: version });
    assert.equal(status.status, 1, `status must fail health check for ${version}`);
    assert.match(status.stdout, /Pi compatibility:/);
  }

  assert.equal((await h.calls()).includes('npm '), false, 'diagnostics never reinstall Pi');
});

test('doctor reports a missing Pi executable separately from an incompatible installation', async () => {
  const h = await compatibilityFixture();
  await h.initialize();
  await unlink(h.piPath);

  const result = h.invoke(['doctor']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^MISSING Pi$/m);
  assert.match(result.stdout, /MISSING Pi compatibility: Pi is missing/);
  assert.doesNotMatch(result.stdout, /UNSUPPORTED Pi compatibility/);
  assert.equal((await h.calls()).includes('npm '), false);
});

test('start rejects unsupported and unparseable Pi before sync, recovery, resume claim, or launch', async () => {
  const h = await compatibilityFixture();
  await h.initialize();

  const template = await readFile(join(packageRoot, 'resources/HANDOFF.template.md'), 'utf8');
  const inProgress = template.replace(/(## Work Status\s*\n)[^\n]+/, '$1IN_PROGRESS');
  await writeFile(join(h.repo, '.agent/HANDOFF.md'), inProgress);
  const recoveryText = JSON.stringify({
    version: 1,
    repoRoot: h.repo,
    status: 'active',
    updatedAt: '2026-10-06T00:00:00.000Z',
    userRequest: 'A task interrupted by a crash',
    toolCount: 1,
    currentTool: { name: 'bash', startedAt: '2026-10-06T00:00:00.000Z' },
  }, null, 2) + '\n';
  const recoveryPath = join(h.repo, '.agent/RECOVERY.json');
  const lastCrashPath = join(h.repo, '.agent/RECOVERY.last-crash.json');
  await writeFile(recoveryPath, recoveryText);
  const handoffFingerprint = fingerprint(inProgress);
  const claimPath = join(h.repo, '.agent/HANDOFF.resume.claims', `${handoffFingerprint}.json`);

  for (const version of ['0.100.0', 'invalid Pi version']) {
    await h.clearCalls();
    const result = h.invoke(['start'], { FAKE_PI_VERSION: version });
    assert.equal(result.status, 1, version);
    assert.match(result.stderr, /Installed Pi is not supported/);
    assert.match(result.stderr, /doctor/);
    assert.doesNotMatch(await h.calls(), /codegraph \["sync"\]|^pi /m);
    assert.equal(await readFile(recoveryPath, 'utf8'), recoveryText);
    assert.equal(await readResumeGuard(h.repo), null);
    await assert.rejects(access(claimPath), { code: 'ENOENT' });
    await assert.rejects(access(lastCrashPath), { code: 'ENOENT' });
  }

  // Once the interrupted recovery journal is removed and a supported Pi is
  // restored, the untouched IN_PROGRESS checkpoint can still be claimed.
  await unlink(recoveryPath);
  await h.clearCalls();
  const supportedStart = h.invoke(['start']);
  assert.equal(supportedStart.status, 0, supportedStart.stderr);
  assert.equal((await readResumeGuard(h.repo))?.consumed, true);
  assert.match(await h.calls(), /codegraph \["sync"\]/);
  assert.match(await h.calls(), /^pi /m);
});

test('init installs the pinned Pi version only when Pi is missing and authorized', async () => {
  const h = await compatibilityFixture({ withPi: false });
  const result = h.invoke(['init', '--install-tools']);
  assert.equal(result.status, 0, result.stderr);

  const calls = await h.calls();
  assert.match(calls, /npm \["install","-g","--ignore-scripts","@earendil-works\/pi-coding-agent@0\.99\.2"\]/);
  assert.doesNotMatch(calls, /pi-coding-agent@latest/);
  await access(h.piPath);
});

test('init preserves an installed unsupported Pi and update does not update Pi core', async () => {
  const h = await compatibilityFixture();
  await h.initialize();

  const init = h.invoke(['init', '--install-tools'], { FAKE_PI_VERSION: '0.100.0' });
  assert.equal(init.status, 1);
  assert.match(init.stderr, /outside validated range/);
  assert.match(init.stderr, /will not replace or downgrade Pi/);
  assert.equal(await h.calls(), '', 'incompatible init performs no install or package mutation');

  const update = h.invoke(['update'], { FAKE_PI_VERSION: '0.100.0' });
  assert.equal(update.status, 0, update.stderr);
  const calls = await h.calls();
  assert.match(calls, /pi \["update","npm:@izhimu\/pi-codegraph@0\.3\.0","--approve"\]/);
  assert.doesNotMatch(calls, /@earendil-works\/pi-coding-agent/);
  assert.doesNotMatch(calls, /npm \["install"/);
});
