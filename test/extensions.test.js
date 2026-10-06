import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import supervisor from '../extensions/session-supervisor.ts';
import handoff from '../extensions/handoff.ts';
import sync from '../extensions/codegraph-auto-sync.ts';
import codegraphGuard from '../extensions/codegraph-guard.ts';
import { packageRoot } from '../lib/cli.js';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { readResumeGuard } from '../lib/resume-guard.js';

async function harness(extension) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-handoff-extension-'));
  await mkdir(join(cwd, '.agent'));
  const template = await readFile(join(packageRoot, 'resources/HANDOFF.template.md'), 'utf8');
  await writeFile(join(cwd, '.agent/HANDOFF.md'), template);
  const handlers = new Map(), commands = new Map(), tools = new Map(), messages = [], notices = [];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool),
    sendUserMessage: (...args) => messages.push(args),
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
  const ctx = { cwd, isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => ({ percent: 20 }), ui: { notify: (...args) => notices.push(args) } };
  extension(pi);
  return { cwd, template, handlers, commands, tools, messages, notices, ctx, pi,
    emit: async (event, data = {}) => handlers.get(event)?.(data, ctx),
    toolCall: async (data = {}) => handlers.get('tool_call')?.(data, ctx),
    write: async text => writeFile(join(cwd, '.agent/HANDOFF.md'), text),
  };
}

test('supervisor waits for queues, verifies changed handoff, and requests only one reset', async () => {
  const h = await harness(supervisor);
  await h.tools.get('request_handoff').execute('id', { reason: 'feature complete' });
  h.ctx.hasPendingMessages = () => true;
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 0);
  h.ctx.hasPendingMessages = () => false;
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);
  await h.write(h.template + '\nVerified: new work completed.\n');
  await h.emit('agent_settled');
  assert.deepEqual(h.messages[1], ['/new-handoff', { expandPromptTemplates: true }]);
  await h.emit('session_start');
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 2);
});
test('supervisor preserves session when handoff is unchanged or invalid', async () => {
  for (const bad of [null, '# incomplete handoff']) {
    const h = await harness(supervisor);
    await h.tools.get('request_handoff').execute('id', { reason: 'checkpoint' });
    await h.emit('agent_settled');
    if (bad !== null) await h.write(bad);
    await h.emit('agent_settled');
    assert.equal(h.messages.length, 1);
    assert.match(h.notices.at(-1)[0], /Session preserved/);
  }
});
test('70 percent context triggers preparation; cancel prevents pending reset', async () => {
  const h = await harness(supervisor);
  h.ctx.getContextUsage = () => ({ percent: 70 });
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);
  await h.commands.get('supervisor-cancel').handler('', h.ctx);
  await h.write(h.template + '\nRefreshed.\n');
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);
});

test('context pressure boundaries distinguish normal, soft, and hard states', async () => {
  const normal = await harness(supervisor);
  normal.ctx.getContextUsage = () => ({ percent: 64.9 });
  await normal.emit('tool_execution_end', { toolName: 'edit', isError: false });
  await normal.emit('agent_settled');
  assert.equal(normal.messages.length, 0);
  assert.equal(await normal.toolCall({ toolName: 'next-tool' }), undefined);

  const soft = await harness(supervisor);
  for (const percent of [65, 66.5, 69.9]) {
    soft.ctx.getContextUsage = () => ({ percent });
    await soft.emit('tool_execution_end', { toolName: 'edit', isError: false });
    await soft.emit('turn_end', { turnIndex: 1, toolResults: [] });
    assert.equal(await soft.toolCall({ toolName: 'next-tool' }), undefined);
    await soft.emit('agent_settled');
    assert.equal(soft.messages.length, 0);
  }

  soft.ctx.getContextUsage = () => ({ percent: 70 });
  await soft.emit('tool_execution_end', { toolName: 'edit', isError: false });
  assert.deepEqual(await soft.toolCall({ toolName: 'next-tool' }), {
    block: true,
    terminate: true,
    reason: 'Context pressure requires a safe handoff.',
  });
});

test('hard pressure is latched after a completed tool during the active loop', async () => {
  const h = await harness(supervisor);
  let percent = 69;
  let abortCalls = 0;
  h.ctx.getContextUsage = () => ({ percent });
  h.ctx.abort = () => { abortCalls++; };

  // This call started while pressure was below the hard threshold.
  assert.equal(await h.toolCall({ toolName: 'migration-write' }), undefined);
  percent = 70;
  const completedTool = { toolName: 'migration-write', isError: false, result: { content: [] } };
  await h.emit('tool_execution_end', completedTool);

  assert.equal(completedTool.isError, false, 'the threshold-crossing tool result remains completed');
  assert.equal(abortCalls, 0, 'the supervisor does not abort an already-running tool');
  assert.equal(h.messages.length, 0, 'preparation waits for the safe settled boundary');
  assert.deepEqual(await h.toolCall({ toolName: 'later-tool' }), {
    block: true,
    terminate: true,
    reason: 'Context pressure requires a safe handoff.',
  });

  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0][0], /Prepare a session handoff/);
});

test('hard pressure and duplicate events converge on one refreshed handoff lifecycle', async () => {
  const h = await harness(supervisor);
  h.ctx.getContextUsage = () => ({ percent: 70 });
  await h.emit('tool_execution_end', { toolName: 'edit', isError: false });
  await h.emit('turn_end', { turnIndex: 1, toolResults: [] });
  await h.emit('tool_execution_end', { toolName: 'edit-again', isError: false });
  assert.equal(h.messages.length, 0);

  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);

  // The control turn remains above the threshold while it refreshes HANDOFF.md.
  await h.emit('tool_execution_end', { toolName: 'write-handoff', isError: false });
  await h.emit('turn_end', { turnIndex: 2, toolResults: [] });
  await h.write(h.template + '\nVerified: pressure checkpoint refreshed.\n');
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 2, 'control-turn pressure cannot recursively prepare another handoff');
  assert.deepEqual(h.messages[1], ['/new-handoff', { expandPromptTemplates: true }]);
  await h.emit('session_start');
  h.ctx.getContextUsage = () => ({ percent: 20 });
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 2, 'the handoff lifecycle requests only one reset');
});

test('explicit request_handoff and hard pressure converge in either order', async () => {
  for (const order of ['request-first', 'pressure-first']) {
    const h = await harness(supervisor);
    h.ctx.getContextUsage = () => ({ percent: 70 });
    if (order === 'request-first') {
      await h.tools.get('request_handoff').execute('id', { reason: 'feature complete' });
      await h.emit('tool_execution_end', { toolName: 'edit', isError: false });
    } else {
      await h.emit('tool_execution_end', { toolName: 'edit', isError: false });
      await h.tools.get('request_handoff').execute('id', { reason: 'feature complete' });
    }
    await h.emit('agent_settled');
    await h.emit('tool_execution_end', { toolName: 'handoff-control', isError: false });
    await h.write(h.template + `\nVerified: ${order} checkpoint refreshed.\n`);
    await h.emit('agent_settled');
    assert.equal(h.messages.length, 2, `${order} must prepare once and request one reset`);
    assert.deepEqual(h.messages[1], ['/new-handoff', { expandPromptTemplates: true }]);
  }
});

test('supervisor cancel suppresses pressure until a new session resets the state', async () => {
  const h = await harness(supervisor);
  h.ctx.getContextUsage = () => ({ percent: 70 });
  await h.emit('tool_execution_end', { toolName: 'edit', isError: false });
  await h.commands.get('supervisor-cancel').handler('', h.ctx);
  await h.emit('turn_end', { turnIndex: 1, toolResults: [] });
  await h.emit('tool_execution_end', { toolName: 'later-edit', isError: false });
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 0);

  await h.emit('session_start');
  await h.emit('tool_execution_end', { toolName: 'new-session-edit', isError: false });
  assert.deepEqual(await h.toolCall({ toolName: 'after-reset' }), {
    block: true,
    terminate: true,
    reason: 'Context pressure requires a safe handoff.',
  });
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);
});

test('missing context usage is ignored and the supervisor remains operational', async () => {
  const h = await harness(supervisor);
  for (const usage of [undefined, {}, { percent: undefined }, { percent: null }]) {
    h.ctx.getContextUsage = () => usage;
    await h.emit('tool_execution_end', { toolName: 'edit', isError: false });
    await h.emit('turn_end', { turnIndex: 1, toolResults: [] });
    await h.emit('agent_settled');
    assert.equal(await h.toolCall({ toolName: 'next-tool' }), undefined);
    assert.equal(h.messages.length, 0);
  }
  await h.tools.get('request_handoff').execute('id', { reason: 'manual request still works' });
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);
});

test('pressure preparation failure is suppressed until a new session', async () => {
  const h = await harness(supervisor);
  h.ctx.getContextUsage = () => ({ percent: 70 });
  await h.emit('tool_execution_end', { toolName: 'edit', isError: false });
  await h.emit('agent_settled');
  await h.write('# invalid refreshed handoff');
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);
  assert.match(h.notices.at(-1)[0], /Session preserved/);

  await h.emit('tool_execution_end', { toolName: 'later-edit', isError: false });
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1, 'failure does not retry automatically in the same session');

  await h.emit('session_start');
  await h.emit('tool_execution_end', { toolName: 'new-session-edit', isError: false });
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 2, 'a new session clears pressure suppression');
});

test('parallel-batch completion does not imply an already-running sibling can be cancelled', async () => {
  const h = await harness(supervisor);
  h.ctx.getContextUsage = () => ({ percent: 69 });

  // Both calls have passed tool_call and represent work already in the active batch.
  assert.equal(await h.toolCall({ toolName: 'tool-a' }), undefined);
  assert.equal(await h.toolCall({ toolName: 'tool-b' }), undefined);
  h.ctx.getContextUsage = () => ({ percent: 70 });
  await h.emit('tool_execution_end', { toolName: 'tool-a', isError: false });
  assert.equal(h.messages.length, 0);
  await h.emit('tool_execution_end', { toolName: 'tool-b', isError: false });
  assert.equal(h.messages.length, 0);

  // The next call is the one the supervisor can stop; the simulated batch does
  // not claim to model Pi's internal scheduling of true parallel tool execution.
  assert.deepEqual(await h.toolCall({ toolName: 'tool-c' }), {
    block: true,
    terminate: true,
    reason: 'Context pressure requires a safe handoff.',
  });
  await h.emit('agent_settled');
  assert.equal(h.messages.length, 1);
});
test('new-handoff uses fresh session context and refuses invalid state', async () => {
  const h = await harness(handoff);
  let replaced = 0;
  const sent = [];
  h.ctx.newSession = async options => {
    replaced++;
    await options.withSession({ sendUserMessage: async text => sent.push(text) });
    return { cancelled: false };
  };
  await h.commands.get('new-handoff').handler('', h.ctx);
  assert.equal(replaced, 1);
  assert.match(sent[0], /Read .agent\/HANDOFF.md first/);
  await h.write('invalid');
  await h.commands.get('new-handoff').handler('', h.ctx);
  assert.equal(replaced, 1);
});
test('new-handoff resumes an IN_PROGRESS checkpoint only once', async () => {
  const h = await harness(handoff);

  const inProgress = h.template.replace(
    /(## Work Status\s*\n)[^\n]+/,
    '$1IN_PROGRESS',
  );

  await h.write(inProgress);

  let replaced = 0;
  const sent = [];

  h.ctx.newSession = async options => {
    replaced++;

    await options.withSession({
      sendUserMessage: async text => {
        sent.push(text);
      },
    });

    return {
      cancelled: false,
    };
  };

  // First continuation is allowed.
  await h.commands
    .get('new-handoff')
    .handler('', h.ctx);

  assert.equal(replaced, 1);
  assert.equal(sent.length, 1);

  const guard =
    await readResumeGuard(h.cwd);

  assert.equal(
    guard?.consumed,
    true,
  );

  assert.equal(
    guard?.workStatus,
    'IN_PROGRESS',
  );

  // Same exact HANDOFF checkpoint must not create
  // another continuation session.
  await h.commands
    .get('new-handoff')
    .handler('', h.ctx);

  assert.equal(
    replaced,
    1,
    'same IN_PROGRESS checkpoint must be resumed only once',
  );

  assert.match(
    h.notices.at(-1)[0],
    /already been resumed/,
  );
});
test('new-handoff releases IN_PROGRESS checkpoint when session creation is cancelled', async () => {
  const h = await harness(handoff);

  const inProgress = h.template.replace(
    /(## Work Status\s*\n)[^\n]+/,
    '$1IN_PROGRESS',
  );

  await h.write(inProgress);

  h.ctx.newSession = async () => ({
    cancelled: true,
  });

  await h.commands
    .get('new-handoff')
    .handler('', h.ctx);

  const guard =
    await readResumeGuard(h.cwd);

  assert.equal(
    guard,
    null,
    'cancelled session creation must release the consumed checkpoint',
  );

  assert.match(
    h.notices.at(-1)[0],
    /cancelled/i,
  );
});
test('sync failures retain dirty state for retry', async () => {
  const h = await harness(sync);
  await mkdir(join(h.cwd, '.codegraph'));
  let attempts = 0;
  h.pi.exec = async () => ({ code: ++attempts === 1 ? 1 : 0, stderr: 'temporary failure' });
  await h.emit('tool_execution_end', { toolName: 'edit', isError: false });
  await h.emit('agent_settled');
  await h.emit('agent_settled');
  await h.emit('agent_settled');
  assert.equal(attempts, 2);
});

test('CodeGraph guard allows ls, known-file reads, normal development, and output filtering', async () => {
  const allowed = [
    ['bash', 'ls'],
    ['bash', 'ls -la'],
    ['bash', 'ls src'],
    ['bash', 'ls ./src/components'],
    ['bash', 'npx vitest run | grep failed'],
    ['bash', 'pytest -q | grep FAILED'],
    ['bash', 'npm test 2>&1 | grep Error'],
    ['bash', 'grep ERROR build.log'],
    ['bash', 'grep -i warning output.txt'],
    ['bash', 'cat build.log | grep ERROR'],
    ['bash', 'npm test | rg failed'],
    ['bash', 'python script.py | rg result'],
    ['bash', 'npm test 2>&1 | grep FAIL'],
    ['bash', 'command | grep x | head'],
    ['bash', 'cat src/foo.ts'],
    ['bash', 'head -100 src/foo.ts'],
    ['bash', "sed -n '1,80p' src/foo.ts"],
    ['bash', 'npm test'],
    ['bash', 'npx vitest'],
    ['bash', 'pytest'],
    ['bash', 'git status'],
    ['bash', 'git diff'],
  ];

  for (const [toolName, command] of allowed) {
    const h = await harness(codegraphGuard);
    assert.equal(
      await h.toolCall({ toolName, input: { command } }),
      undefined,
      `${toolName}: ${command} should be allowed before CodeGraph`,
    );
    assert.equal(h.notices.length, 0);
  }
});

test('CodeGraph guard blocks direct discovery producers before orientation', async () => {
  const blocked = [
    ['bash', 'rg "SomeSymbol"'],
    ['bash', 'rg "SomeSymbol" .'],
    ['bash', 'rg -n "SomeSymbol" src'],
    ['bash', 'rg "SomeSymbol" . | head'],
    ['bash', 'find . -type f'],
    ['bash', 'find src -name "*.ts"'],
    ['bash', 'find .agent -type f'],
    ['bash', 'find . -type f | head'],
    ['bash', 'grep -R "SomeSymbol" .'],
    ['bash', 'grep -rn "SomeSymbol" src'],
    ['powershell', 'rg "SomeSymbol" .'],
    ['powershell', 'find . -type f'],
  ];

  for (const [toolName, command] of blocked) {
    const h = await harness(codegraphGuard);
    const result = await h.toolCall({ toolName, input: { command } });
    assert.equal(result?.block, true, `${toolName}: ${command} should be blocked`);
    assert.match(result.reason, /CodeGraph/i);
    assert.equal(h.messages.length, 0, 'a blocked call produces no queued messages');
    assert.equal(h.notices.length, 0, 'a blocked call produces no repeated notices');
  }
});

test('CodeGraph tool attempt unlocks fallback discovery until the next agent turn', async () => {
  const h = await harness(codegraphGuard);
  const rg = { toolName: 'bash', input: { command: 'rg "SomeSymbol" .' } };
  const find = { toolName: 'find', input: { pattern: '*.ts', path: 'src' } };

  const blocked = await h.toolCall(rg);
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /CodeGraph/i);

  // tool_call fires before execution, so the guard treats an attempted
  // CodeGraph invocation as the point where fallback discovery is unlocked.
  assert.equal(await h.toolCall({ toolName: 'codegraph_explore', input: { query: 'SomeSymbol' } }), undefined);
  assert.equal(await h.toolCall(rg), undefined);
  assert.equal(await h.toolCall(find), undefined);

  // before_agent_start, not session_start or turn_start, resets the latch.
  await h.emit('before_agent_start', { prompt: 'Next agent turn' });
  const blockedAgain = await h.toolCall(rg);
  assert.equal(blockedAgain?.block, true);
  assert.match(blockedAgain.reason, /CodeGraph/i);
  assert.equal((await h.toolCall(find))?.block, true);
});

test('native Pi find is guarded for directory roots and unlocked after CodeGraph use', async () => {
  const h = await harness(codegraphGuard);
  const search = { toolName: 'find', input: { pattern: '**/*.ts', path: '.' } };
  assert.equal((await h.toolCall(search))?.block, true);
  assert.equal(await h.toolCall({ toolName: 'codegraph_explore', input: { query: 'source files' } }), undefined);
  assert.equal(await h.toolCall(search), undefined);
});
test('new-handoff releases IN_PROGRESS checkpoint when session creation throws', async () => {
  const h = await harness(handoff);

  const inProgress = h.template.replace(
    /(## Work Status\s*\n)[^\n]+/,
    '$1IN_PROGRESS',
  );

  await h.write(inProgress);

  h.ctx.newSession = async () => {
    throw new Error('synthetic session failure');
  };

  await assert.rejects(
    () =>
      h.commands
        .get('new-handoff')
        .handler('', h.ctx),
    /synthetic session failure/,
  );

  const guard =
    await readResumeGuard(h.cwd);

  assert.equal(
    guard,
    null,
    'failed session creation must release the consumed checkpoint',
  );
});
test('real Pi loader loads package once and excludes legacy files only for this project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-handoff-loader-'));
  const cwd = join(root, 'repo'), agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  const names = [
  'handoff.ts',
  'session-supervisor.ts',
  'codegraph-auto-sync.ts',
  'codegraph-guard.ts',
  'recovery.ts',
];
  const paths = names.map(name => join(agentDir, 'extensions', name));
  for (const path of paths) await writeFile(path, 'export default function(pi) { pi.registerCommand("legacy", { description: "legacy", handler: async () => {} }); }');
  await writeFile(join(cwd, '.pi/settings.json'), JSON.stringify({ packages: [packageRoot], extensions: paths.flatMap(path => [path, `-${path}`]) }));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.filter(extension => extension.path.endsWith('/extensions/index.ts')).length, 1);
  assert.equal(result.extensions.filter(extension => paths.includes(extension.path)).length, 0);
  const loaded = result.extensions.find(extension => extension.path.endsWith('/extensions/index.ts'));
  assert.ok(loaded.commands.has('handoff'));
  assert.ok(loaded.commands.has('new-handoff'));
  assert.ok(loaded.tools.has('request_handoff'));
  for (const path of paths) assert.match(await readFile(path, 'utf8'), /legacy/);
});
