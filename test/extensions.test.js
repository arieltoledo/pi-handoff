import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import supervisor from '../extensions/session-supervisor.ts';
import handoff from '../extensions/handoff.ts';
import sync from '../extensions/codegraph-auto-sync.ts';
import { packageRoot } from '../lib/cli.js';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

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
test('real Pi loader loads package once and excludes legacy files only for this project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-handoff-loader-'));
  const cwd = join(root, 'repo'), agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  const names = ['handoff.ts', 'session-supervisor.ts', 'codegraph-auto-sync.ts', 'codegraph-guard.ts'];
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
