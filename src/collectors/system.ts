import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname, loadavg, freemem, totalmem, uptime } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function diskUsage() {
  try {
    const { stdout } = await exec("df", ["-Pk", "/"]);
    const columns = stdout.trim().split("\n").at(-1)?.split(/\s+/);
    return columns?.[4] ? Number(columns[4].replace("%", "")) : null;
  } catch {
    return null;
  }
}

async function networkUsage() {
  try {
    const contents = await readFile("/proc/net/dev", "utf8");
    let received = 0;
    let sent = 0;
    for (const line of contents.split("\n").slice(2)) {
      const [name, counters] = line.split(":");
      if (!name || !counters || name.trim() === "lo") continue;
      const values = counters.trim().split(/\s+/).map(Number);
      received += values[0] ?? 0;
      sent += values[8] ?? 0;
    }
    return { networkReceivedBytes: received, networkSentBytes: sent };
  } catch {
    return { networkReceivedBytes: 0, networkSentBytes: 0 };
  }
}

export async function collectSystemMetrics() {
  const total = totalmem();
  const free = freemem();
  const network = await networkUsage();
  return {
    hostname: hostname(),
    uptimeSeconds: Math.floor(uptime()),
    loadAverage: loadavg(),
    memoryTotalBytes: total,
    memoryUsedBytes: total - free,
    memoryUsedPercent: Number((((total - free) / total) * 100).toFixed(2)),
    diskUsedPercent: await diskUsage(),
    ...network,
  };
}
