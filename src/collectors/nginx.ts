import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const logDirectory = "/var/log/nginx";
const stateDirectory = "/var/lib/legacy-hosting-agent";
const statePath = join(stateDirectory, "traffic-offsets.json");
const maxReadBytes = 16 * 1024 * 1024;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type Offset = { inode: string; offset: number };
type State = Record<string, Offset>;

let state: State | null = null;

async function loadState() {
  if (state) return state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as State;
  } catch {
    state = {};
  }
  return state;
}

function responseBytes(lines: string) {
  let total = 0;
  for (const line of lines.split("\n")) {
    const match = line.match(/"\s+\d{3}\s+(\d+|-)\s+/);
    if (match?.[1] && match[1] !== "-") total += Number(match[1]);
  }
  return total;
}

export async function collectNginxTraffic() {
  try {
    const offsets = await loadState();
    const files = (await readdir(logDirectory)).filter(
      (name) => name.startsWith("lh-") && name.endsWith(".access.log"),
    );
    const traffic: { hostname: string; bytesSent: number }[] = [];

    for (const file of files) {
      const hostname = file.slice(3, -".access.log".length);
      if (!hostnamePattern.test(hostname)) continue;
      const path = join(logDirectory, file);
      const handle = await open(path, "r");
      try {
        const details = await handle.stat();
        const inode = String(details.ino);
        const previous = offsets[file];
        const start =
          previous?.inode === inode && previous.offset <= details.size
            ? previous.offset
            : 0;
        const length = Math.min(Math.max(0, details.size - start), maxReadBytes);
        if (!length) {
          offsets[file] = { inode, offset: start };
          continue;
        }
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const chunk = buffer.subarray(0, bytesRead);
        const finalNewline = chunk.lastIndexOf(10);
        if (finalNewline < 0) continue;
        const complete = chunk.subarray(0, finalNewline + 1).toString("utf8");
        offsets[file] = { inode, offset: start + finalNewline + 1 };
        traffic.push({ hostname, bytesSent: responseBytes(complete) });
      } finally {
        await handle.close();
      }
    }

    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(statePath, JSON.stringify(offsets), { mode: 0o600 });
    return traffic;
  } catch {
    return [];
  }
}
