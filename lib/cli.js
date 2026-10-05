import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHandoff, resumePrompt, validateHandoff } from './handoff.js';
import {
  needsCrashRecovery,
  preserveCrashRecovery,
  readRecovery,
  recoveryPrompt,
} from './recovery.js';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codegraphSource = 'npm:@izhimu/pi-codegraph@0.3.0';
const legacyFiles = [
  'handoff.ts',
  'session-supervisor.ts',
  'codegraph-auto-sync.ts',
  'codegraph-guard.ts',
  'recovery.ts',
];
const startMarker = '<!-- pi-handoff:start -->';
const endMarker = '<!-- pi-handoff:end -->';

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error(`Cannot read ${path}: ${error.message}`); }
}
export function mergeAgents(existing, fragment) {
  const start = existing.indexOf(startMarker), end = existing.indexOf(endMarker);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start) || existing.indexOf(startMarker, start + 1) >= 0 || existing.indexOf(endMarker, end + 1) >= 0) {
    throw new Error('AGENTS.md has malformed or repeated pi-handoff markers; repair them before init.');
  }
  if (start >= 0) return existing.slice(0, start) + fragment.trimEnd() + existing.slice(end + endMarker.length);
  return `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${fragment.trimEnd()}\n`;
}
function run(command, args, cwd, { dry = false, capture = false } = {}) {
  if (dry) { console.log(`[dry-run] ${command} ${args.map(arg => JSON.stringify(arg)).join(' ')}`); return ''; }
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr ?? '').trim()}`);
  return (result.stdout ?? '').trim();
}
function available(command, cwd) {
  const result = spawnSync(command, ['--version'], { cwd, encoding: 'utf8' });
  return result.status === 0 ? (result.stdout ?? '').trim() : null;
}
function sourceOf(entry) { return typeof entry === 'string' ? entry : entry.source; }
function hasCodegraph(settings) {
  return (settings.packages ?? []).some(entry => /^npm:@izhimu\/pi-codegraph(?:@|$)/.test(sourceOf(entry)));
}
function hasSelf(settings, repo) {
  return (settings.packages ?? []).some(entry => {
    const source = sourceOf(entry);
    if (/^npm:@arieltoledo\/pi-handoff(?:@|$)/.test(source)) return true;
    return !/^(npm:|git:|https?:|ssh:)/.test(source) && resolve(join(repo, '.pi'), source) === packageRoot;
  });
}
async function readText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function main(argv) {
  let command = argv[0] ?? 'help';
  if (['--help', '-h'].includes(command)) command = 'help';
  if (!['init', 'doctor', 'status', 'update', 'start', 'help'].includes(command)) throw new Error(`Unknown command: ${command}`);
  let cwd = process.cwd(), dry = false, installTools = false;
  const piArgs = [];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { piArgs.push(...argv.slice(index + 1)); break; }
    if (arg === '--cwd') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--cwd requires a directory');
      cwd = resolve(argv[++index]);
    } else if (arg === '--dry-run') dry = true;
    else if (arg === '--install-tools') installTools = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (piArgs.length && command !== 'start') throw new Error('Pi arguments are only supported by start');
  if (installTools && command !== 'init') throw new Error('--install-tools is only supported by init');
  if (command === 'help') {
    console.log('pi-handoff init|doctor|status|update|start [--cwd DIR] [--dry-run]\ninit --install-tools: install missing Pi/CodeGraph CLIs with npm -g\nstart -- [PI OPTIONS]: sync the index and start Pi from HANDOFF.md');
    return 0;
  }
  // Resolve the repository root when invoked from a subdirectory. Non-Git projects are supported.
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (git.status === 0) cwd = git.stdout.trim();
  if (!existsSync(cwd)) throw new Error(`Directory does not exist: ${cwd}`);
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent');
  const settingsPath = join(cwd, '.pi', 'settings.json');
  let local = await json(settingsPath);
  const global = await json(join(agentDir, 'settings.json'));
  const legacy = legacyFiles.map(file => join(agentDir, 'extensions', file)).filter(existsSync);
  const localLegacy = legacyFiles.map(file => join(cwd, '.pi', 'extensions', file)).filter(existsSync);
  // Pi resolves explicit project resources before global auto-discovery. A bare
  // negative pattern cannot shadow a global resource: register its path AND
  // exclude it so the disabled project entry wins over the global entry.
  const legacyPaths = [...legacy, ...localLegacy];
  const exclusions = legacyPaths.flatMap(path => [path, `-${path}`]);
  const handoff = await readHandoff(cwd);
  const agentsPath = join(cwd, 'AGENTS.md');
  const agents = await readText(agentsPath);
  const fragment = await readFile(join(packageRoot, 'resources', 'AGENTS.fragment.md'), 'utf8');
  const mergedAgents = mergeAgents(agents, fragment);
  const piVersion = available('pi', cwd), cgVersion = available('codegraph', cwd);

  if (command === 'doctor' || command === 'status') {
    const checks = [
      ['Node', process.version], ['Pi', piVersion], ['CodeGraph', cgVersion],
      ['Handoff package (project)', hasSelf(local, cwd)],
      ['CodeGraph extension', hasCodegraph(local) || hasCodegraph(global)],
      ['CodeGraph index', existsSync(join(cwd, '.codegraph'))],
      ['HANDOFF.md', validateHandoff(handoff) === null],
      ['AGENTS.md lifecycle rules', agents.includes(startMarker) && agents.includes(endMarker)],
      ['Legacy extensions excluded in this project', exclusions.every(path => (local.extensions ?? []).includes(path))],
    ];
    console.log(`Project: ${cwd}`);
    for (const [name, value] of checks) console.log(`${value ? 'OK' : 'MISSING'} ${name}${typeof value === 'string' ? `: ${value}` : ''}`);
    if (legacy.length) console.log(`Legacy global files: ${legacy.length} (kept intact; excluded only in initialized projects).`);
    // Provider configuration is optional and never read from auth.json.
    if (command === 'doctor') {
      console.log(`INFO llama-server: ${available('llama-server', cwd) ?? 'not in PATH (may be running separately)'}`);
      console.log(`INFO Pi llama provider: ${(global.packages ?? []).some(entry => sourceOf(entry).includes('pi-llama')) ? 'configured' : 'not declared as a package'}`);
    }
    if (command === 'status' && cgVersion && existsSync(join(cwd, '.codegraph'))) run('codegraph', ['status'], cwd);
    return checks.every(([, value]) => !!value) ? 0 : 1;
  }
  if (command === 'init') {
    if ((!piVersion || !cgVersion) && !installTools) throw new Error('Missing Pi or CodeGraph CLI. Run init --install-tools to install missing tools with npm -g.');
    if (!piVersion) run('npm', ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent@0.99.2'], cwd, { dry });
    if (!cgVersion) run('npm', ['install', '-g', '@colbymchenry/codegraph@1.6.1'], cwd, { dry });
    if (!hasCodegraph(local) && !hasCodegraph(global)) run('pi', ['install', codegraphSource, '-l', '--approve'], cwd, { dry });
    if (!hasSelf(local, cwd)) run('pi', ['install', packageRoot, '-l', '--approve'], cwd, { dry });
    if (!dry) {
      local = await json(settingsPath); // Preserve settings written by Pi itself.
      if (!Array.isArray(local.extensions ?? [])) throw new Error('settings.extensions must be an array');
      const next = [...new Set([...(local.extensions ?? []), ...exclusions])];
      if (JSON.stringify(next) !== JSON.stringify(local.extensions ?? [])) {
        local.extensions = next;
        await mkdir(dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, `${JSON.stringify(local, null, 2)}\n`);
      }
    } else console.log(`[dry-run] Exclude ${legacyPaths.length} legacy extension files in project settings`);
    if (!existsSync(join(cwd, '.codegraph'))) run('codegraph', ['init', '--yes'], cwd, { dry });
    if (!dry) {
      await mkdir(join(cwd, '.agent'), { recursive: true });
      if (handoff === null) await writeFile(join(cwd, '.agent', 'HANDOFF.md'), await readFile(join(packageRoot, 'resources', 'HANDOFF.template.md')), { flag: 'wx' });
      if (mergedAgents !== agents) await writeFile(agentsPath, mergedAgents);
    } else console.log('[dry-run] Create missing HANDOFF.md and merge managed AGENTS.md block');
    console.log(dry ? 'Dry run complete; no files changed.' : `Initialized ${cwd}. Run pi-handoff doctor, then pi-handoff start.`);
    return 0;
  }
  if (!piVersion || !cgVersion) throw new Error('Pi and CodeGraph must be available. Run init --install-tools.');
  if (!hasSelf(local, cwd)) throw new Error('This project is not initialized. Run pi-handoff init.');
  if (command === 'update') {
    // Local source uses the working package files directly; no npm publication is assumed.
    const configuredCodegraph = [...(local.packages ?? []), ...(global.packages ?? [])].map(sourceOf).find(source => /^npm:@izhimu\/pi-codegraph(?:@|$)/.test(source));
    if (configuredCodegraph) run('pi', ['update', configuredCodegraph, '--approve'], cwd, { dry });
    const selfNpm = (local.packages ?? []).map(sourceOf).find(source => source.startsWith('npm:@arieltoledo/pi-handoff'));
    if (selfNpm) run('pi', ['update', selfNpm, '--approve'], cwd, { dry });
    else console.log(`Local package: ${packageRoot}; edits are available on Pi restart or /reload.`);
    return 0;
  }
  const error = validateHandoff(handoff);
  if (error) throw new Error(`${error}. Run init or repair the handoff.`);
  if (!hasCodegraph(local) && !hasCodegraph(global)) throw new Error('CodeGraph extension missing. Run init.');
  if (!exclusions.every(path => (local.extensions ?? []).includes(path))) throw new Error('Legacy extension collisions detected. Run init to exclude them in this project.');
  if (!existsSync(join(cwd, '.codegraph'))) throw new Error('CodeGraph index missing. Run init.');
  
  run('codegraph', ['sync'], cwd, { dry });

  const recovery = await readRecovery(cwd);

  let prompt = resumePrompt;

  if (needsCrashRecovery(recovery)) {
    if (!dry) {
      await preserveCrashRecovery(cwd);
    }

    console.log(
      `RECOVERY: previous Pi session ended unexpectedly` +
      (recovery.sessionId ? ` (${recovery.sessionId})` : '')
    );

    if (recovery.currentTool?.name) {
      console.log(
        `RECOVERY: unfinished tool: ${recovery.currentTool.name}`
      );
    }

    prompt = recoveryPrompt(recovery);
  }

  run('pi', [...piArgs, '--', prompt], cwd, { dry });

  return 0;
}
