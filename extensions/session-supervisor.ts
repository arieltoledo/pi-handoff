import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fingerprint, preparePrompt, readHandoff, validateHandoff } from '../lib/handoff.js';

const SOFT_CONTEXT_PERCENT = 65;
const HARD_CONTEXT_PERCENT = 70;

type SupervisorPhase =
  | 'idle'
  | 'soft-pressure'
  | 'hard-pressure-pending'
  | 'handoff-requested'
  | 'preparing-handoff'
  | 'handoff-running'
  | 'validating-handoff'
  | 'reset-pending'
  | 'cancelled';

function getContextPercent(ctx: Pick<ExtensionContext, 'getContextUsage'>): number | undefined {
  try {
    const percent = ctx.getContextUsage?.()?.percent;
    return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0
      ? percent
      : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let phase: SupervisorPhase = 'idle';
  let reason = '';
  let before: string | null = null;
  let generation = 0;
  let recoveryMode = false;
  const reset = () => { generation++; phase = 'idle'; reason = ''; before = null; recoveryMode = false; };
  pi.on('session_start', async () => reset());
  pi.on('before_agent_start', async event => {
    // Recovery startup supplies this explicit diagnosis-only prompt. Keep the
    // session in recovery mode for later turns until a new Pi session starts.
    if (/^\s*RECOVERY MODE\b/.test(event.prompt)) recoveryMode = true;
  });

  function checkContextPressure(ctx: ExtensionContext): void {
    // Handoff-control turns must not recursively request another handoff.
    if (recoveryMode) return;
    if (
      phase === 'handoff-requested' ||
      phase === 'preparing-handoff' ||
      phase === 'handoff-running' ||
      phase === 'validating-handoff' ||
      phase === 'reset-pending' ||
      phase === 'hard-pressure-pending' ||
      phase === 'cancelled'
    ) return;

    const percent = getContextPercent(ctx);
    if (percent === undefined) return;

    if (percent >= HARD_CONTEXT_PERCENT) {
      phase = 'hard-pressure-pending';
      reason = `context pressure: ${percent.toFixed(1)}%`;
    } else if (percent >= SOFT_CONTEXT_PERCENT && phase === 'idle') {
      // Soft pressure is monotonic for this session, avoiding threshold oscillation.
      phase = 'soft-pressure';
    }
  }

  function preserveSession(): void {
    generation++;
    phase = 'cancelled';
    reason = '';
    before = null;
  }

  // Tool execution end runs after the operation has returned. Latch pressure here
  // so later calls can be stopped without aborting an in-flight tool.
  pi.on('tool_execution_end', async (_event, ctx) => checkContextPressure(ctx));
  pi.on('turn_end', async (_event, ctx) => checkContextPressure(ctx));
  pi.on('tool_call', async (_event, ctx) => {
    if (phase !== 'hard-pressure-pending') return;
    // Pi finalizes a blocked result and honors terminate after the current batch.
    return { block: true, terminate: true, reason: 'Context pressure requires a safe handoff.' };
  });
  pi.registerTool({
    name: 'request_handoff', label: 'Request Session Handoff',
    description: 'Request a verified session handoff after completing a semantic unit of work, or when a context reset is necessary. Record unfinished work accurately for context resets.',
    parameters: Type.Object({ reason: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      if (recoveryMode) {
        return { content: [{ type: 'text', text: 'Supervisor handoffs are disabled during Crash Recovery diagnosis.' }], details: { phase, reason } };
      }
      if (phase === 'idle' || phase === 'soft-pressure' || phase === 'cancelled') {
        phase = 'handoff-requested'; reason = params.reason;
      }
      return { content: [{ type: 'text', text: `Supervisor: ${phase}. The handoff begins after the agent settles.` }], details: { phase, reason } };
    },
  });
  pi.registerCommand('supervisor-status', {
    description: 'Show the session supervisor state',
    handler: async (_args, ctx) => { ctx.ui.notify(`Supervisor: ${phase}${reason ? ` — ${reason}` : ''}`, 'info'); },
  });
  pi.registerCommand('supervisor-cancel', {
    description: 'Cancel a pending session reset',
    handler: async (_args, ctx) => {
      preserveSession();
      ctx.ui.notify('Automatic session reset cancelled.', 'info');
    },
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (recoveryMode) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (
      phase === 'preparing-handoff' ||
      phase === 'validating-handoff' ||
      phase === 'reset-pending'
    ) return;
    const token = generation;
    try {
      if (phase === 'idle') {
        checkContextPressure(ctx);
      }
      if (phase === 'idle' || phase === 'soft-pressure' || phase === 'cancelled') return;
      if (phase === 'hard-pressure-pending') phase = 'handoff-requested';
      if (phase === 'handoff-requested') {
        // Latch before awaiting disk I/O so concurrent settled events cannot
        // start a second preparation for the same transition.
        phase = 'preparing-handoff';
        before = fingerprint(await readHandoff(ctx.cwd));
        if (token !== generation) return;
        phase = 'handoff-running';
        ctx.ui.notify(`Preparing handoff: ${reason}`, 'info');
        // Send the prompt directly; session replacement remains a command-only operation.
        pi.sendUserMessage(preparePrompt);
        return;
      }
      phase = 'validating-handoff';
      const text = await readHandoff(ctx.cwd);
      if (token !== generation) return;
      const error = validateHandoff(text) ?? (fingerprint(text) === before ? 'HANDOFF.md was not refreshed.' : null);
      if (error) {
        preserveSession();
        ctx.ui.notify(`Session preserved: ${error}`, 'warning');
        return;
      }
      // Keep this transition latched until Pi starts the replacement session.
      // Repeated settled events must not enqueue another fresh-session command.
      phase = 'reset-pending';
      pi.sendUserMessage('/new-handoff', { expandPromptTemplates: true });
    } catch (error) {
      if (token !== generation) return;
      preserveSession();
      ctx.ui.notify(`Session preserved: ${String(error)}`, 'warning');
    }
  });
}
