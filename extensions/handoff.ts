import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { preparePrompt, readHandoff, resumePrompt, validateHandoff } from '../lib/handoff.js';

export default function (pi: ExtensionAPI) {
  pi.registerCommand('handoff', {
    description: 'Prepare .agent/HANDOFF.md for a fresh session',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify('Wait until the agent and its queued messages finish.', 'warning');
        return;
      }
      pi.sendUserMessage(preparePrompt);
    },
  });
  pi.registerCommand('new-handoff', {
    description: 'Start a fresh session using a validated HANDOFF.md',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify('Wait until the agent and its queued messages finish.', 'warning');
        return;
      }
      const error = validateHandoff(await readHandoff(ctx.cwd));
      if (error) { ctx.ui.notify(error, 'warning'); return; }
      const result = await ctx.newSession({
        withSession: async fresh => { await fresh.sendUserMessage(resumePrompt); },
      });
      if (result.cancelled) ctx.ui.notify('New session cancelled.', 'info');
    },
  });
}
