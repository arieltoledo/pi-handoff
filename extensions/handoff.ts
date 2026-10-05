import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  fingerprint,
  getWorkStatus,
  preparePrompt,
  readHandoff,
  resumePrompt,
  validateHandoff,
} from "../lib/handoff.js";

import { claimResume, releaseResume } from "../lib/resume-guard.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Prepare .agent/HANDOFF.md for a fresh session",

    handler: async (_args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Wait until the agent and its queued messages finish.",
          "warning",
        );
        return;
      }

      pi.sendUserMessage(preparePrompt);
    },
  });

  pi.registerCommand("new-handoff", {
    description: "Start a fresh session using a validated HANDOFF.md",

    handler: async (_args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Wait until the agent and its queued messages finish.",
          "warning",
        );
        return;
      }

      const handoff = await readHandoff(ctx.cwd);

      const error = validateHandoff(handoff);

      if (error) {
        ctx.ui.notify(error, "warning");
        return;
      }

      const status = getWorkStatus(handoff);
      const handoffFingerprint = fingerprint(handoff);

      /**
       * Only IN_PROGRESS handoffs may continue automatically.
       *
       * COMPLETE / BLOCKED / AWAITING_USER still create a fresh
       * session, but resumePrompt will tell that session to verify
       * state and wait for the user.
       */
      if (status === "IN_PROGRESS" && handoffFingerprint) {
        const claim = await claimResume(ctx.cwd, handoffFingerprint, {
          workStatus: status,
          sourceSessionId: ctx.sessionManager?.getSessionId?.() ?? null,
          source: "/new-handoff",
        });

        if (!claim) {
          ctx.ui.notify(
            "This IN_PROGRESS handoff has already been resumed. " +
              "Refusing to create another continuation session from " +
              "the same checkpoint. Prepare a new handoff or continue " +
              "in the current session.",
            "warning",
          );

          return;
        }
      }

      let result;

      try {
        result = await ctx.newSession({
          withSession: async (fresh) => {
            await fresh.sendUserMessage(resumePrompt);
          },
        });
      } catch (error) {
        /**
         * Session creation failed before continuation could begin.
         * Release the checkpoint so the user may retry safely.
         */
        if (status === "IN_PROGRESS" && handoffFingerprint) {
          await releaseResume(ctx.cwd, handoffFingerprint);
        }

        throw error;
      }

      /**
       * If Pi explicitly cancelled creation of the new session,
       * release the one-shot marker so the user may retry.
       */
      if (result.cancelled) {
        if (status === "IN_PROGRESS" && handoffFingerprint) {
          await releaseResume(ctx.cwd, handoffFingerprint);
        }

        ctx.ui.notify("New session cancelled.", "info");
      }
    },
  });
}
