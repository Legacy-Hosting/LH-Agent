import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { signPayload, signPayloadV2 } from "./signature.js";

export type AgentCommand = {
  id: string;
  type:
    | "deploy"
    | "start"
    | "stop"
    | "restart"
    | "delete"
    | "configure_proxy"
    | "renew_certificate"
    | "logs"
    | "write_persistent_file";
  leaseToken: string;
  payload: {
    deploymentId?: string;
    commitSha?: string | null;
    lines?: number;
    domainId?: string;
    hostname?: string;
    rootDomain?: string;
    routes?: Array<{ prefix: string; port: number; processName: string }>;
    path?: string;
    content?: string;
    restartProcesses?: boolean;
  };
  application: null | {
    id: string;
    storagePath: string;
    processName: string;
    internalPort: number;
    repository: string | null;
    branch: string | null;
    hostname: string | null;
    rootDomain: string | null;
    hostnames: string[];
    runtime: {
      kind: "node";
      install: { command: string; args: string[] };
      build: { command: string; args: string[] } | null;
      start: { command: string; args: string[] } | null;
      checks?: Array<{ command: string; args: string[] }>;
    } | null;
    cleanupProcessNames?: string[];
    proxies?: Array<{
      hostname: string;
      routes: Array<{ prefix: string; port: number; processName: string }>;
    }>;
    processes: Array<{
      id: string;
      name: string;
      processName: string;
      type: "web" | "api" | "bot" | "worker" | "custom";
      workingDirectory: string;
      start: { command: string; args: string[] };
      internalPort: number | null;
      primary: boolean;
      public: boolean;
      routes: string[];
      enabled: boolean;
      startOrder: number;
      instances: number;
      restartDelayMs: number;
      inheritEnvironment: boolean;
      healthPath: string | null;
      hostVariable: string | null;
      portVariable: string | null;
      environment: Record<string, string>;
      hostname: string | null;
      rootDomain: string | null;
    }>;
    persistentPaths: Array<{
      path: string;
      type: "file" | "directory";
    }>;
    environment: Record<string, string>;
    generatedEnvironment: Record<string, string>;
    github: { token: string; expiresAt: string } | null;
    tls: { cloudflareToken: string; acmeEmail: string } | null;
  };
};

export type CommandResultMetadata = {
  certificateExpiresAt?: string;
  deploymentCommitSha?: string;
};

async function signedPost(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const nonce = randomUUID();
  const response = await fetch(`${config.LH_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LH-Node-ID": config.LH_NODE_ID,
      "X-LH-Timestamp": timestamp,
      "X-LH-Signature": signPayload(config.LH_AGENT_TOKEN, timestamp, body),
      "X-LH-Nonce": nonce,
      "X-LH-Signature-V2": signPayloadV2(
        config.LH_AGENT_TOKEN,
        timestamp,
        nonce,
        body,
      ),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `API request ${path} rejected with status ${response.status}`,
    );
  return response;
}

export async function sendHeartbeat(payload: unknown) {
  const response = await signedPost("/agent/heartbeat", payload);
  return response.json() as Promise<{
    accepted: true;
    serverTime: string;
  }>;
}

export async function claimCommand() {
  const response = await signedPost("/agent/commands/claim", {
    requestedAt: new Date().toISOString(),
  });
  return response.json() as Promise<{
    command: AgentCommand | null;
    serverTime: string;
  }>;
}

export async function sendCommandResult(
  commandId: string,
  leaseToken: string,
  succeeded: boolean,
  output: string,
  metadata?: CommandResultMetadata,
  cancelled = false,
) {
  await signedPost("/agent/commands/result", {
    commandId,
    leaseToken,
    succeeded,
    cancelled,
    output: output.slice(0, 200_000),
    metadata,
  });
}

export async function sendCommandProgress(
  commandId: string,
  leaseToken: string,
  chunk: string,
) {
  const response = await signedPost("/agent/commands/progress", {
    commandId,
    leaseToken,
    chunk: chunk.slice(0, 65_536),
  });
  return response.json() as Promise<{
    accepted: true;
    cancelRequested: boolean;
  }>;
}
