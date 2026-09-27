import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);
const commandEnvironment = { ...process.env, LC_ALL: "C" };

export function parseFail2BanStatus(output: string, jail = "sshd") {
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes("Banned IP list:"));
  const addresses = line?.split("Banned IP list:", 2)[1]?.trim() ?? "";
  return [...new Set(addresses.split(/\s+/).filter((value) => isIP(value) > 0))]
    .slice(0, 1000)
    .map((ipAddress) => ({ ipAddress, jail }));
}

export async function collectFail2BanBans() {
  try {
    const { stdout } = await exec("fail2ban-client", ["status", "sshd"], {
      env: commandEnvironment,
      maxBuffer: 1024 * 1024,
    });
    return parseFail2BanStatus(stdout);
  } catch {
    return [];
  }
}
