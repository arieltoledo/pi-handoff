import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import path from "node:path";

type RecoveryStatus =
  | "active"
  | "settled"
  | "clean";

interface RecoveryTool {
  id?: string;
  name: string;
  input?: unknown;
  startedAt?: string;
  completedAt?: string;
  isError?: boolean;
}

interface RecoveryContextUsage {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
}

interface RecoveryState {
  version: 1;

  repoRoot: string;
  sessionId?: string;

  status: RecoveryStatus;
  updatedAt: string;

  userRequest?: string;

  currentTool?: RecoveryTool;
  lastCompletedTool?: RecoveryTool;

  toolCount: number;

  context?: RecoveryContextUsage;

  shutdownReason?:
    | "quit"
    | "reload"
    | "new"
    | "resume"
    | "fork";
}

export default function (pi: ExtensionAPI) {
  const repoRoot = process.cwd();

  const agentDir = path.join(repoRoot, ".agent");
  const recoveryFile = path.join(
    agentDir,
    "RECOVERY.json"
  );

  const tempFile = path.join(
    agentDir,
    "RECOVERY.json.tmp"
  );

  let state: RecoveryState = {
    version: 1,
    repoRoot,
    status: "clean",
    updatedAt: new Date().toISOString(),
    toolCount: 0,
  };

  function now(): string {
    return new Date().toISOString();
  }

  function updateContext(ctx: any): void {
    try {
      const usage = ctx.getContextUsage?.();

      if (!usage) return;

      state.context = {
        tokens: usage.tokens ?? null,
        contextWindow: usage.contextWindow ?? null,
        percent: usage.percent ?? null,
      };
    } catch {
      // Recovery journaling must never interfere with Pi.
    }
  }

  function updateSession(ctx: any): void {
    try {
      const id =
        ctx.sessionManager?.getSessionId?.();

      if (id) {
        state.sessionId = id;
      }
    } catch {
      // Non-critical metadata.
    }
  }

  /**
   * Crash-safe-ish atomic write:
   *
   * 1. write temporary file
   * 2. fsync temporary file
   * 3. rename over RECOVERY.json
   *
   * A process/power failure should therefore leave either
   * the previous complete file or the new complete file.
   */
  function persist(): void {
    try {
      mkdirSync(agentDir, {
        recursive: true,
      });

      const json =
        JSON.stringify(state, null, 2) + "\n";

      writeFileSync(
        tempFile,
        json,
        "utf8"
      );

      try {
        const fd = openSync(tempFile, "r");

        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // fsync is best-effort; do not break Pi.
      }

      try {
        renameSync(
          tempFile,
          recoveryFile
        );
      } catch {
        /**
         * Conservative cross-platform fallback.
         *
         * Some environments may refuse replacing the
         * destination with rename().
         */
        try {
          if (existsSync(recoveryFile)) {
            rmSync(recoveryFile, {
              force: true,
            });
          }

          renameSync(
            tempFile,
            recoveryFile
          );
        } catch {
          // Recovery support must never crash the agent.
        }
      }
    } catch {
      // Never let journaling break the coding session.
    }
  }

  function save(ctx?: any): void {
    state.updatedAt = now();

    if (ctx) {
      updateSession(ctx);
      updateContext(ctx);
    }

    persist();
  }

  /**
   * New user-authorized work begins.
   *
   * before_agent_start is preferable to turn_start because
   * it gives us the actual user prompt and fires before the
   * agent loop begins.
   */
  pi.on(
    "before_agent_start",
    async (event, ctx) => {
      state = {
        version: 1,
        repoRoot,

        sessionId:
          ctx.sessionManager
            ?.getSessionId?.(),

        status: "active",
        updatedAt: now(),

        userRequest: event.prompt,

        toolCount: 0,
      };

      save(ctx);
    }
  );

  /**
   * Record the tool BEFORE execution.
   *
   * If power/process failure occurs during the tool,
   * this is the operation that must be treated as
   * potentially incomplete during recovery.
   */
  pi.on(
    "tool_call",
    async (event, ctx) => {
      state.status = "active";

      state.currentTool = {
        id: (event as any).toolCallId,
        name: event.toolName,
        input: (event as any).input,
        startedAt: now(),
      };

      save(ctx);

      return undefined;
    }
  );

  /**
   * Tool completed.
   *
   * Move it from currentTool to lastCompletedTool.
   */
  pi.on(
    "tool_result",
    async (event, ctx) => {
      state.toolCount += 1;

      state.lastCompletedTool = {
        id: (event as any).toolCallId,
        name: event.toolName,

        input:
          state.currentTool?.input,

        startedAt:
          state.currentTool?.startedAt,

        completedAt: now(),

        isError:
          (event as any).isError ?? false,
      };

      state.currentTool = undefined;

      save(ctx);
    }
  );

  /**
   * The agent reached a stable point.
   *
   * This is NOT the same as a graceful application exit.
   * It simply means Pi has no more automatic work pending.
   */
  pi.on(
    "agent_settled",
    async (_event, ctx) => {
      state.status = "settled";
      state.currentTool = undefined;

      save(ctx);
    }
  );

  /**
   * Graceful Pi shutdown/session replacement.
   *
   * An actual crash will never reach this handler, which
   * is precisely how the next startup can distinguish an
   * interrupted session from a clean one.
   */
  pi.on(
    "session_shutdown",
    async (event, ctx) => {
      state.status = "clean";
      state.shutdownReason = event.reason;
      state.currentTool = undefined;

      save(ctx);
    }
  );

  /**
   * Diagnostic command.
   *
   * /recovery-status
   */
  pi.registerCommand(
    "recovery-status",
    {
      description:
        "Show crash-recovery journal status",

      handler: async (_args, ctx) => {
        const tool =
          state.currentTool
            ? ` — current tool: ${state.currentTool.name}`
            : "";

        const usage =
          state.context?.percent != null
            ? ` — context ${state.context.percent.toFixed(1)}%`
            : "";

        ctx.ui.notify(
          `Recovery: ${state.status}${tool}${usage}`,
          "info"
        );
      },
    }
  );
}
