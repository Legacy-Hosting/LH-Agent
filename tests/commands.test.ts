import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentCommand } from "../src/core/api.js";
import {
  environmentForProcess,
  nginxConfiguration,
} from "../src/core/commands.js";

type Application = NonNullable<AgentCommand["application"]>;
type ApplicationProcess = Application["processes"][number];

const processConfiguration: ApplicationProcess = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "api",
  processName: "team-bifrost-api",
  type: "api",
  workingDirectory: "V2/Bifrost-API",
  start: { command: "node", args: ["dist/server.js"] },
  internalPort: 3003,
  primary: false,
  public: true,
  routes: ["/api/*", "/health", "/ready"],
  enabled: true,
  startOrder: 1,
  instances: 1,
  restartDelayMs: 1000,
  inheritEnvironment: true,
  healthPath: "/health",
  hostVariable: "BIFROST_API_HOST",
  portVariable: "BIFROST_API_PORT",
  environment: { DATABASE_HOST: "db.internal", PORT: "9999" },
  hostname: "tg.legacyh.dev",
  rootDomain: "legacyh.dev",
};

const application = {
  environment: { NODE_ENV: "production", SHARED_SECRET: "shared" },
  generatedEnvironment: {
    LH_PROCESS_API_HOST: "127.0.0.1",
    LH_PROCESS_API_PORT: "3003",
    BIFROST_API_HOST: "127.0.0.1",
    BIFROST_API_PORT: "3003",
  },
} as Application;

test("the agent always replaces user PORT values with the assigned process port", () => {
  const environment = environmentForProcess(application, processConfiguration);
  assert.equal(environment.PORT, "3003");
  assert.equal(environment.BIFROST_API_PORT, "3003");
  assert.equal(environment.DATABASE_HOST, "db.internal");
  assert.equal(environment.SHARED_SECRET, "shared");
});

test("processes can opt out of shared secrets while keeping generated connectivity variables", () => {
  const environment = environmentForProcess(application, {
    ...processConfiguration,
    inheritEnvironment: false,
    environment: {},
  });
  assert.equal(environment.SHARED_SECRET, undefined);
  assert.equal(environment.LH_PROCESS_API_PORT, "3003");
  assert.equal(environment.PORT, "3003");
});

test("nginx routes multiple automatically assigned ports on one hostname", () => {
  const configuration = nginxConfiguration("tg.legacyh.dev", [
    { prefix: "/api/*", port: 3003, processName: "api" },
    { prefix: "/health", port: 3003, processName: "api" },
    { prefix: "/", port: 3002, processName: "web" },
  ]);
  assert.match(configuration, /location \^~ \/api\//);
  assert.match(configuration, /127\.0\.0\.1:3003/);
  assert.match(configuration, /location \/ \{/);
  assert.match(configuration, /127\.0\.0\.1:3002/);
  assert.match(configuration, /proxy_no_cache 1/);
});
