import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFail2BanStatus } from "../src/collectors/fail2ban.js";
import {
  firewallReconciliationPlan,
  parseManagedFirewallRules,
} from "../src/core/firewall.js";

test("Fail2Ban status exposes only valid unique banned addresses", () => {
  const reports = parseFail2BanStatus(`Status for the jail: sshd
|- Filter
\`- Actions
   |- Currently banned: 3
   \`- Banned IP list: 8.8.8.8 2606:4700:4700::1111 invalid 8.8.8.8
`);
  assert.deepEqual(reports, [
    { ipAddress: "8.8.8.8", jail: "sshd" },
    { ipAddress: "2606:4700:4700::1111", jail: "sshd" },
  ]);
});

test("global firewall reconciliation adds missing and removes stale or duplicate rules", () => {
  const status = `Status: active

To                         Action      From
--                         ------      ----
[ 1] Anywhere              DENY IN     8.8.4.4 # Legacy Hosting global ban
[ 2] Anywhere              DENY IN     1.1.1.1 # Legacy Hosting global ban
[ 3] Anywhere              DENY IN     1.1.1.1 # Legacy Hosting global ban
[ 4] 22/tcp                ALLOW IN    Anywhere # SSH
`;
  assert.deepEqual(parseManagedFirewallRules(status), [
    { number: 1, ipAddress: "8.8.4.4" },
    { number: 2, ipAddress: "1.1.1.1" },
    { number: 3, ipAddress: "1.1.1.1" },
  ]);
  assert.deepEqual(
    firewallReconciliationPlan(status, ["1.1.1.1", "9.9.9.9"]),
    { deleteRules: [3, 1], addIps: ["9.9.9.9"] },
  );
});
