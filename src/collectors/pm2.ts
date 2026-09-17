import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

type Pm2Process = {
  name?: string;
  pid?: number;
  pm_id?: number;
  monit?: { cpu?: number; memory?: number };
  pm2_env?: {
    status?: string;
    restart_time?: number;
    pm_uptime?: number;
    versioning?: { revision?: string };
    pm_cwd?: string;
  };
};

const storageCache = new Map<string, { bytes: number | null; expiresAt: number }>();

async function storageBytes(path: string | undefined) {
  if (!path || !path.startsWith("/home/")) return null;
  const cached = storageCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.bytes;
  let bytes: number | null = null;
  try {
    const { stdout } = await exec("du", ["-sk", "--", path], {
      maxBuffer: 1024 * 1024,
    });
    const kibibytes = Number(stdout.trim().split(/\s+/)[0]);
    bytes = Number.isFinite(kibibytes) ? kibibytes * 1024 : null;
  } catch {
    bytes = null;
  }
  storageCache.set(path, { bytes, expiresAt: Date.now() + 5 * 60_000 });
  return bytes;
}

export async function collectPm2Processes() {
  try {
    const { stdout } = await exec("pm2", ["jlist"], {
      maxBuffer: 5 * 1024 * 1024,
    });
    const processes = JSON.parse(stdout) as Pm2Process[];
    return Promise.all(
      processes.map(async (process) => ({
        pm2Id: process.pm_id ?? null,
        name: process.name ?? "unknown",
        pid: process.pid ?? null,
        status: process.pm2_env?.status ?? "unknown",
        cpuPercent: process.monit?.cpu ?? 0,
        memoryBytes: process.monit?.memory ?? 0,
        storageBytes: await storageBytes(process.pm2_env?.pm_cwd),
        restartCount: process.pm2_env?.restart_time ?? 0,
        startedAt: process.pm2_env?.pm_uptime
          ? new Date(process.pm2_env.pm_uptime).toISOString()
          : null,
        revision: process.pm2_env?.versioning?.revision ?? null,
      })),
    );
  } catch {
    return [];
  }
}
