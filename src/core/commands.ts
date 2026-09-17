import { X509Certificate } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize, parse, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { AgentCommand } from "./api.js";

const hostname =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const executableAllowlist = new Set(["npm", "pnpm", "yarn", "bun", "node"]);
const nginxConfigurationDirectory = "/etc/nginx/conf.d";
const letsEncryptLiveDirectory = "/etc/letsencrypt/live";
type ExecutionContext = {
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
};
const executionContext = new AsyncLocalStorage<ExecutionContext>();

export class CommandCancelledError extends Error {
  constructor() {
    super("Command cancelled");
    this.name = "CommandCancelledError";
  }
}

export type CommandExecutionResult = {
  output: string;
  metadata?: {
    certificateExpiresAt?: string;
    deploymentCommitSha?: string;
  };
};

function safeStoragePath(value: string) {
  const resolved = normalize(value);
  const parts = resolved.split(sep).filter(Boolean);
  if (
    parse(resolved).root !== sep ||
    parts.length !== 3 ||
    parts[0] !== "home" ||
    !hostname.test(parts[1]!) ||
    !hostname.test(parts[2]!)
  ) {
    throw new Error("Unsafe application storage path");
  }
  return resolved;
}

function safeProcessName(value: string) {
  if (!/^[A-Za-z0-9_.-]{2,120}$/.test(value))
    throw new Error("Unsafe PM2 process name");
  return value;
}

function safeHostname(value: string | null) {
  if (!value || !hostname.test(value)) throw new Error("Unsafe hostname");
  return value;
}

function requireRootLinux() {
  if (process.platform !== "linux")
    throw new Error("Proxy and certificate commands require Linux");
  if (typeof process.getuid !== "function" || process.getuid() !== 0)
    throw new Error("Proxy and certificate commands require root privileges");
}

function safeRuntimeCommand(command: { command: string; args: string[] }) {
  if (!executableAllowlist.has(command.command))
    throw new Error(`Runtime executable ${command.command} is not allowed`);
  if (
    command.args.length > 30 ||
    command.args.some(
      (argument) => argument.includes("\0") || argument.length > 500,
    )
  ) {
    throw new Error("Runtime arguments are invalid");
  }
  return command;
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
    timeoutMs?: number;
  } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const context = executionContext.getStore();
    if (context?.signal?.aborted) {
      reject(new CommandCancelledError());
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    context?.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-180_000);
      context?.onOutput?.(text);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      context?.signal?.removeEventListener("abort", cancel);
      if (cancelled) {
        reject(new CommandCancelledError());
        return;
      }
      if (timedOut) {
        reject(new Error(`${command} timed out\n${output}`));
        return;
      }
      if (code === 0 || options.allowFailure) resolve(output);
      else reject(new Error(`${command} exited with code ${code}\n${output}`));
    });
  });
}

async function withGitCredentials<T>(
  token: string,
  action: (environment: NodeJS.ProcessEnv) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "lh-git-"));
  const askPass = join(directory, "askpass.sh");
  await writeFile(
    askPass,
    '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *Password*) printf "%s\\n" "$LH_GITHUB_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
  await chmod(askPass, 0o700);
  try {
    return await action({
      GIT_ASKPASS: askPass,
      GIT_TERMINAL_PROMPT: "0",
      LH_GITHUB_TOKEN: token,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withCloudflareCredentials<T>(
  token: string,
  action: (credentialsPath: string) => Promise<T>,
) {
  if (!token || token.length > 4096 || /[\r\n\0]/.test(token))
    throw new Error("Invalid Cloudflare access token");
  const directory = await mkdtemp(join(tmpdir(), "lh-cloudflare-"));
  const credentialsPath = join(directory, "cloudflare.ini");
  await writeFile(
    credentialsPath,
    `dns_cloudflare_api_token = ${token}\n`,
    { mode: 0o600 },
  );
  await chmod(credentialsPath, 0o600);
  try {
    return await action(credentialsPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function nginxConfiguration(host: string, port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid application port");
  return `# Managed by Legacy Hosting. Local changes will be overwritten.
server {
    listen 80;
    listen [::]:80;
    server_name ${host};

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${host};

    ssl_certificate ${letsEncryptLiveDirectory}/${host}/fullchain.pem;
    ssl_certificate_key ${letsEncryptLiveDirectory}/${host}/privkey.pem;

    client_max_body_size 100m;
    access_log /var/log/nginx/lh-${host}.access.log combined;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 60s;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
`;
}

async function installNginxConfiguration(
  host: string,
  port: number,
  commandId: string,
) {
  const target = join(nginxConfigurationDirectory, `lh-${host}.conf`);
  const temporary = join(
    nginxConfigurationDirectory,
    `.lh-${host}-${commandId}.tmp`,
  );
  const previous = (await exists(target)) ? await readFile(target) : null;
  await writeFile(temporary, nginxConfiguration(host, port), { mode: 0o644 });
  await rename(temporary, target);
  try {
    const tested = await run("nginx", ["-t"]);
    const reloaded = await run("nginx", ["-s", "reload"]);
    return `${tested}${reloaded}`;
  } catch (error) {
    if (previous) await writeFile(target, previous, { mode: 0o644 });
    else await rm(target, { force: true });
    await run("nginx", ["-t"], { allowFailure: true });
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeNginxConfiguration(host: string) {
  const target = join(nginxConfigurationDirectory, `lh-${host}.conf`);
  if (!(await exists(target))) return "";
  const previous = await readFile(target);
  await rm(target);
  try {
    const tested = await run("nginx", ["-t"]);
    const reloaded = await run("nginx", ["-s", "reload"]);
    return `${tested}${reloaded}`;
  } catch (error) {
    await writeFile(target, previous, { mode: 0o644 });
    await run("nginx", ["-t"], { allowFailure: true });
    throw error;
  }
}

async function certificateExpiration(host: string) {
  const certificatePath = join(
    letsEncryptLiveDirectory,
    host,
    "fullchain.pem",
  );
  const certificate = new X509Certificate(await readFile(certificatePath));
  const expiration = new Date(certificate.validTo);
  if (Number.isNaN(expiration.getTime()))
    throw new Error("Could not read certificate expiration");
  return expiration.toISOString();
}

async function configureProxy(
  command: AgentCommand,
): Promise<CommandExecutionResult> {
  requireRootLinux();
  const application = command.application;
  if (!application?.tls)
    throw new Error("Proxy command is missing TLS credentials");
  const host = safeHostname(application.hostname);
  const rootDomain = safeHostname(application.rootDomain);
  if (host !== rootDomain && !host.endsWith(`.${rootDomain}`))
    throw new Error("Hostname is outside its configured root domain");
  const email = application.tls.acmeEmail;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Invalid ACME account email");

  let output = await withCloudflareCredentials(
    application.tls.cloudflareToken,
    (credentialsPath) =>
      run("certbot", [
        "certonly",
        "--non-interactive",
        "--agree-tos",
        "--email",
        email,
        "--dns-cloudflare",
        "--dns-cloudflare-credentials",
        credentialsPath,
        "--dns-cloudflare-propagation-seconds",
        "30",
        "--cert-name",
        host,
        "-d",
        host,
        "--keep-until-expiring",
      ]),
  );
  output += await installNginxConfiguration(
    host,
    application.internalPort,
    command.id,
  );
  return {
    output,
    metadata: { certificateExpiresAt: await certificateExpiration(host) },
  };
}

async function deploy(command: AgentCommand) {
  const application = command.application;
  if (
    !application?.repository ||
    !application.branch ||
    !application.runtime ||
    !application.github
  ) {
    throw new Error(
      "Deploy command is missing repository or runtime configuration",
    );
  }
  const storagePath = safeStoragePath(application.storagePath);
  const parent = dirname(storagePath);
  const repositoryUrl = `https://github.com/${application.repository}.git`;
  const branch = application.branch;
  const commit = command.payload.commitSha;
  if (commit && !/^[a-f0-9]{40}$/i.test(commit))
    throw new Error("Invalid deployment commit");
  await mkdir(parent, { recursive: true });
  let output = "";

  await withGitCredentials(application.github.token, async (gitEnvironment) => {
    if (!(await exists(join(storagePath, ".git")))) {
      if (await exists(storagePath))
        throw new Error(
          "Application directory exists but is not a Git repository",
        );
      const temporaryPath = `${storagePath}.lh-${command.id}`;
      if (relative(parent, temporaryPath).startsWith(".."))
        throw new Error("Unsafe temporary deployment path");
      await rm(temporaryPath, { recursive: true, force: true });
      try {
        output += await run(
          "git",
          [
            "clone",
            "--branch",
            branch,
            "--single-branch",
            repositoryUrl,
            temporaryPath,
          ],
          { env: gitEnvironment },
        );
        await rename(temporaryPath, storagePath);
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    } else {
      output += await run(
        "git",
        ["remote", "set-url", "origin", repositoryUrl],
        { cwd: storagePath },
      );
      output += await run("git", ["fetch", "--prune", "origin", branch], {
        cwd: storagePath,
        env: gitEnvironment,
      });
    }
    output += await run(
      "git",
      ["checkout", "-B", branch, commit || `origin/${branch}`],
      { cwd: storagePath },
    );
    output += await run(
      "git",
      ["reset", "--hard", commit || `origin/${branch}`],
      { cwd: storagePath },
    );
    output += await run("git", ["clean", "-fdx"], { cwd: storagePath });
  });
  const revision = (await run("git", ["rev-parse", "HEAD"], {
    cwd: storagePath,
  })).trim();
  if (!/^[a-f0-9]{40}$/i.test(revision))
    throw new Error("Git returned an invalid deployment revision");

  const install = safeRuntimeCommand(application.runtime.install);
  output += await run(install.command, install.args, { cwd: storagePath });
  if (application.runtime.build) {
    const build = safeRuntimeCommand(application.runtime.build);
    output += await run(build.command, build.args, {
      cwd: storagePath,
      env: application.environment,
    });
  }

  const processName = safeProcessName(application.processName);
  const start = safeRuntimeCommand(application.runtime.start);
  output += await run("pm2", ["delete", processName], { allowFailure: true });
  output += await run(
    "pm2",
    [
      "start",
      start.command,
      "--name",
      processName,
      "--cwd",
      storagePath,
      "--",
      ...start.args,
    ],
    {
      env: application.environment,
    },
  );
  output += await run("pm2", ["save"]);
  return { output, revision };
}

async function processControl(command: AgentCommand) {
  const application = command.application;
  if (!application)
    throw new Error("Process command is missing application configuration");
  const processName = safeProcessName(application.processName);
  if (command.type === "stop") return run("pm2", ["stop", processName]);
  return run("pm2", ["restart", processName, "--update-env"], {
    env: application.environment,
  });
}

async function processLogs(command: AgentCommand) {
  const application = command.application;
  if (!application)
    throw new Error("Log command is missing application configuration");
  const processName = safeProcessName(application.processName);
  const lines = Number(command.payload.lines ?? 200);
  if (!Number.isInteger(lines) || lines < 10 || lines > 500)
    throw new Error("Invalid log line count");
  return run(
    "pm2",
    [
      "logs",
      processName,
      "--lines",
      String(lines),
      "--nostream",
      "--raw",
    ],
    { timeoutMs: 20_000 },
  );
}

async function removeApplication(command: AgentCommand) {
  const application = command.application;
  if (!application)
    throw new Error("Delete command is missing application configuration");
  const storagePath = safeStoragePath(application.storagePath);
  const processName = safeProcessName(application.processName);
  let output = await run("pm2", ["delete", processName], {
    allowFailure: true,
  });
  if (application.hostname) {
    requireRootLinux();
    const host = safeHostname(application.hostname);
    output += await removeNginxConfiguration(host);
    output += await run(
      "certbot",
      ["delete", "--non-interactive", "--cert-name", host],
      { allowFailure: true },
    );
  }
  if (await exists(storagePath)) {
    const trash = join(
      dirname(storagePath),
      `.lh-trash-${storagePath.split(sep).at(-1)}-${Date.now()}`,
    );
    if (relative(dirname(storagePath), trash).startsWith(".."))
      throw new Error("Unsafe trash path");
    await rename(storagePath, trash);
    output += `\nMoved application data to ${trash}`;
  }
  output += await run("pm2", ["save"]);
  return output;
}

async function performCommand(
  command: AgentCommand,
): Promise<CommandExecutionResult> {
  if (command.type === "deploy") {
    const result = await deploy(command);
    return {
      output: result.output,
      metadata: { deploymentCommitSha: result.revision },
    };
  }
  if (
    command.type === "start" ||
    command.type === "restart" ||
    command.type === "stop"
  )
    return { output: await processControl(command) };
  if (command.type === "delete")
    return { output: await removeApplication(command) };
  if (
    command.type === "configure_proxy" ||
    command.type === "renew_certificate"
  )
    return configureProxy(command);
  if (command.type === "logs") return { output: await processLogs(command) };
  throw new Error("Unsupported node command");
}

export async function executeCommand(
  command: AgentCommand,
  context: ExecutionContext = {},
) {
  return executionContext.run(context, () => performCommand(command));
}
