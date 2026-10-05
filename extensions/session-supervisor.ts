import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fingerprint, preparePrompt, readHandoff, validateHandoff } from '../lib/handoff.js';

export default function (pi: ExtensionAPI) {
  let phase: 'idle' | 'handoff-requested' | 'handoff-running' = 'idle';
  let reason = '';
  let before: string | null = null;
  let generation = 0;
  let pressureSuppressed = false;
  const reset = () => { generation++; phase = 'idle'; reason = ''; before = null; };
  pi.on('session_start', async () => { reset(); pressureSuppressed = false; });
  pi.on('before_agent_start', async event => {
    if (event.prompt !== preparePrompt) pressureSuppressed = false;
  });
  pi.registerTool({
    name: 'request_handoff', label: 'Request Session Handoff',
    description: 'Request a verified session handoff after completing a semantic unit of work, or when a context reset is necessary. Record unfinished work accurately for context resets.',
    parameters: Type.Object({ reason: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      if (phase === 'idle') { phase = 'handoff-requested'; reason = params.reason; }
      return { content: [{ type: 'text', text: `Supervisor: ${phase}. The handoff begins after the agent settles.` }], details: { phase, reason } };
    },
  });
  pi.registerCommand('supervisor-status', {
    description: 'Show the session supervisor state',
    handler: async (_args, ctx) => { ctx.ui.notify(`Supervisor: ${phase}${reason ? ` — ${reason}` : ''}`, 'info'); },
  });
  pi.registerCommand('supervisor-cancel', {
    description: 'Cancel a pending session reset',
    handler: async (_args, ctx) => { reset(); pressureSuppressed = true; ctx.ui.notify('Automatic session reset cancelled.', 'info'); },
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const token = generation;
    try {
      if (phase === 'idle') {
        if (pressureSuppressed) return;
        const percent = ctx.getContextUsage()?.percent;
        if (percent == null || percent < 70) return;
        phase = 'handoff-requested'; reason = `context pressure: ${percent.toFixed(1)}%`;
      }
      if (phase === 'handoff-requested') {
        before = fingerprint(await readHandoff(ctx.cwd));
        if (token !== generation) return;
        phase = 'handoff-running';
        ctx.ui.notify(`Preparing handoff: ${reason}`, 'info');
        // Send the prompt directly; session replacement remains a command-only operation.
        pi.sendUserMessage(preparePrompt);
        return;
      }
      const text = await readHandoff(ctx.cwd);
      if (token !== generation) return;
      const error = validateHandoff(text) ?? (fingerprint(text) === before ? 'HANDOFF.md was not refreshed.' : null);
      reset();
      if (error) { pressureSuppressed = true; ctx.ui.notify(`Session preserved: ${error}`, 'warning'); return; }
      pi.sendUserMessage('/new-handoff', { expandPromptTemplates: true });
    } catch (error) {
      if (token !== generation) return;
      reset();
      pressureSuppressed = true;
      ctx.ui.notify(`Session preserved: ${String(error)}`, 'warning');
    }
  });
}
