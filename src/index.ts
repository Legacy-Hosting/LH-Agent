import { collectPm2Processes } from "./collectors/pm2.js";
import { collectSystemMetrics } from "./collectors/system.js";
import { collectNginxTraffic } from "./collectors/nginx.js";
import {
  claimCommand,
  sendCommandProgress,
  sendCommandResult,
  sendHeartbeat,
  type AgentCommand,
  type CommandResultMetadata,
} from "./core/api.js";
import { config } from "./core/config.js";
import {
  CommandCancelledError,
  executeCommand,
} from "./core/commands.js";

let stopping = false;

async function delay(milliseconds: number) {
  const until = Date.now() + milliseconds;
  while (!stopping && Date.now() < until) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1_000, until - Date.now())),
    );
  }
}

async function heartbeat() {
  const [system, processes, applicationTraffic] = await Promise.all([
    collectSystemMetrics(),
    collectPm2Processes(),
    collectNginxTraffic(),
  ]);
  await sendHeartbeat({
    agentVersion: "1.0.18",
    sentAt: new Date().toISOString(),
    system,
    processes,
    applicationTraffic,
  });
}

async function execute(command: AgentCommand) {
  let succeeded = false;
  let cancelled = false;
  let output = "";
  let metadata: CommandResultMetadata | undefined;
  let bufferedOutput = "";
  let progressQueue = Promise.resolve();
  const controller = new AbortController();

  function queueProgress(force = false) {
    if (!force && !bufferedOutput) return;
    const chunk = bufferedOutput.slice(0, 65_536);
    bufferedOutput = bufferedOutput.slice(chunk.length);
    progressQueue = progressQueue
      .then(async () => {
        const response = await sendCommandProgress(
          command.id,
          command.leaseToken,
          chunk,
        );
        if (response.cancelRequested) controller.abort();
      })
      .catch((error) => {
        console.error(
          `${new Date().toISOString()} command progress failed`,
          error instanceof Error ? error.message : error,
        );
      });
    if (bufferedOutput) queueProgress();
  }

  const progressTimer = setInterval(() => queueProgress(true), 1_000);
  try {
    const result = await executeCommand(command, {
      signal: controller.signal,
      onOutput(chunk) {
        bufferedOutput = `${bufferedOutput}${chunk}`;
        if (bufferedOutput.length >= 32_768) queueProgress();
      },
    });
    output = result.output;
    metadata = result.metadata;
    succeeded = true;
  } catch (error) {
    cancelled = error instanceof CommandCancelledError;
    output = cancelled
      ? "Cancellation requested; the active process was terminated."
      : error instanceof Error
        ? error.message
        : String(error);
  } finally {
    clearInterval(progressTimer);
    queueProgress(true);
    await progressQueue;
  }
  await sendCommandResult(
    command.id,
    command.leaseToken,
    succeeded,
    output,
    metadata,
    cancelled,
  );
  console.log(
    `${new Date().toISOString()} command ${command.id} ${
      succeeded ? "succeeded" : "failed"
    }`,
  );
}

async function heartbeatLoop() {
  while (!stopping) {
    const started = Date.now();
    try {
      await heartbeat();
      console.log(`${new Date().toISOString()} heartbeat sent`);
    } catch (error) {
      console.error(
        `${new Date().toISOString()} heartbeat failed`,
        error instanceof Error ? error.message : error,
      );
    }
    await delay(
      Math.max(
        1_000,
        config.LH_HEARTBEAT_INTERVAL_MS - (Date.now() - started),
      ),
    );
  }
}

async function commandLoop() {
  while (!stopping) {
    try {
      const response = await claimCommand();
      if (response.command) {
        await execute(response.command);
        continue;
      }
    } catch (error) {
      console.error(
        `${new Date().toISOString()} command poll failed`,
        error instanceof Error ? error.message : error,
      );
    }
    await delay(config.LH_COMMAND_POLL_INTERVAL_MS);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

console.log(`Legacy Hosting Agent 1.0.18 started for node ${config.LH_NODE_ID}`);
await Promise.all([heartbeatLoop(), commandLoop()]);
