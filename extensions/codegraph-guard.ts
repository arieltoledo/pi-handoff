import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  let attempted = false;
  pi.on('before_agent_start', async () => { attempted = false; });
  pi.on('tool_call', async event => {
    if (event.toolName.startsWith('codegraph_')) { attempted = true; return; }
    if (attempted) return;
    const command = event.toolName === 'bash' ? String(event.input?.command ?? '') : '';
    // Best-effort workflow guard, not a shell parser or security boundary.
    if (/(?:^|[;&|\n])\s*(?:find|grep|rg)(?:\s|$)/.test(command) || ['find', 'grep'].includes(event.toolName)) {
      return { block: true, reason: 'Attempt codegraph_explore before broad discovery. Focused fallback searches are allowed after that attempt, including when CodeGraph fails.' };
    }
  });
}
