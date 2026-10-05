import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export default function (pi: ExtensionAPI) {
  let revision = 0;
  let synced = 0;
  pi.on('session_start', async () => { revision = 0; synced = 0; });
  pi.on('tool_execution_end', async event => {
    if (!event.isError && ['edit', 'write', 'apply_patch', 'bash', 'powershell'].includes(event.toolName)) revision++;
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (synced === revision || !existsSync(join(ctx.cwd, '.codegraph'))) return;
    const current = revision;
    try {
      const result = await pi.exec('codegraph', ['sync'], { cwd: ctx.cwd, timeout: 30000 });
      if (result.code === 0) synced = current;
      else ctx.ui.notify(`CodeGraph sync failed: ${result.stderr || result.stdout}`, 'warning');
    } catch (error) { ctx.ui.notify(`CodeGraph sync failed: ${String(error)}`, 'warning'); }
  });
}
