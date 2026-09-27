import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);
const commandEnvironment = { ...process.env, LC_ALL: "C" };
export const globalFirewallComment = "Legacy Hosting global ban";

export type FirewallPolicy = {
  activeIps: string[];
  unbanIps: string[];
};

export type ManagedFirewallRule = {
  number: number;
  ipAddress: string;
};

export function parseManagedFirewallRules(output: string) {
  const rules: ManagedFirewallRule[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes(`# ${globalFirewallComment}`)) continue;
    const number = line.match(/^\[\s*(\d+)\]/)?.[1];
    const rule = line.split("#", 1)[0] ?? "";
    const deny = rule.split("DENY IN", 2)[1]?.trim();
    const ipAddress = deny?.split(/\s+/, 1)[0];
    if (!number || !ipAddress || !isIP(ipAddress)) continue;
    rules.push({ number: Number(number), ipAddress });
  }
  return rules;
}

export function firewallReconciliationPlan(
  status: string,
  activeIps: string[],
) {
  const desired = new Set(activeIps.filter((ipAddress) => isIP(ipAddress)));
  const current = parseManagedFirewallRules(status);
  const kept = new Set<string>();
  const deleteRules: number[] = [];
  for (const rule of current) {
    if (!desired.has(rule.ipAddress) || kept.has(rule.ipAddress))
      deleteRules.push(rule.number);
    else kept.add(rule.ipAddress);
  }
  return {
    deleteRules: deleteRules.sort((left, right) => right - left),
    addIps: [...desired].filter((ipAddress) => !kept.has(ipAddress)).sort(),
  };
}

async function unbanFail2BanAddress(ipAddress: string) {
  if (!isIP(ipAddress)) return;
  try {
    await exec("fail2ban-client", ["set", "sshd", "unbanip", ipAddress], {
      env: commandEnvironment,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // A node may not have observed this address locally. Global UFW
    // reconciliation below still removes the centrally managed rule.
  }
}

export async function reconcileGlobalFirewall(policy: FirewallPolicy) {
  if (process.platform !== "linux") return;
  if (typeof process.getuid !== "function" || process.getuid() !== 0)
    throw new Error("Global firewall reconciliation requires root privileges");

  for (const ipAddress of new Set(policy.unbanIps)) {
    await unbanFail2BanAddress(ipAddress);
  }

  const { stdout } = await exec("ufw", ["status", "numbered"], {
    env: commandEnvironment,
    maxBuffer: 5 * 1024 * 1024,
  });
  const plan = firewallReconciliationPlan(stdout, policy.activeIps);
  for (const number of plan.deleteRules) {
    await exec("ufw", ["--force", "delete", String(number)], {
      env: commandEnvironment,
      maxBuffer: 1024 * 1024,
    });
  }
  for (const ipAddress of plan.addIps) {
    await exec(
      "ufw",
      [
        "insert",
        "1",
        "deny",
        "from",
        ipAddress,
        "to",
        "any",
        "comment",
        globalFirewallComment,
      ],
      { env: commandEnvironment, maxBuffer: 1024 * 1024 },
    );
  }
}
