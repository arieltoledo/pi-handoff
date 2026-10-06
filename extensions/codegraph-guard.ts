import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type Command = { name: string; args: string[] };

/** Split only at shell control operators; this is intentionally a small workflow classifier. */
function commandClauses(command: string): string[] {
  return command.split(/(?:&&|\|\||[;\n])/);
}

function readCommand(text: string): Command | undefined {
  // Retain quoted arguments as one token without attempting full shell parsing.
  const words = text.match(/"(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\s]+/g) ?? [];
  let index = 0;
  while (index < words.length && /^(?:[A-Za-z_][A-Za-z0-9_]*=.*|env|command|sudo|time|noglob)$/.test(words[index])) {
    index++;
  }
  const name = words[index]?.replace(/^(?:.*\/)?/, '');
  if (!name) return undefined;
  return { name, args: words.slice(index + 1) };
}

function isRecursiveGrep(args: string[]): boolean {
  return args.some(arg =>
    arg === '-r' || arg === '-R' || arg === '--recursive' ||
    /^-[^-]*[rR]/.test(arg)
  );
}

function hasRepositoryDiscovery(command: string): boolean {
  return commandClauses(command).some(clause => {
    // Only inspect the first command in each pipeline. Later commands commonly
    // filter test, log, or other command output (for example `pytest | rg FAIL`).
    const firstPipelineCommand = clause.split('|', 1)[0];
    const parsed = readCommand(firstPipelineCommand.trim());
    if (!parsed) return false;
    if (parsed.name === 'find' || parsed.name === 'rg') return true;
    return parsed.name === 'grep' && isRecursiveGrep(parsed.args);
  });
}

function blocksNativeFind(input: Record<string, unknown> | undefined): boolean {
  const searchPath = typeof input?.path === 'string' ? input.path.trim() : '';
  // The native find tool searches recursively from its root. A file-like explicit
  // root is more likely a targeted artifact lookup, so leave it alone.
  if (searchPath && /(?:^|\/)[^/]+\.[^/]+$/.test(searchPath)) return false;
  return true;
}

export default function (pi: ExtensionAPI) {
  let attempted = false;
  pi.on('before_agent_start', async () => { attempted = false; });
  pi.on('tool_call', async event => {
    if (event.toolName.startsWith('codegraph_')) { attempted = true; return; }
    if (attempted) return;

    // Directory listings are basic orientation and are always allowed.
    if (event.toolName === 'ls') return;

    const guarded = event.toolName === 'find'
      ? blocksNativeFind(event.input)
      : event.toolName === 'bash' || event.toolName === 'powershell'
        ? hasRepositoryDiscovery(String(event.input?.command ?? ''))
        : false;

    if (guarded) {
      return {
        block: true,
        reason: 'Use CodeGraph for repository discovery first. If it fails or is insufficient, focused searches are allowed.',
      };
    }
  });
}
