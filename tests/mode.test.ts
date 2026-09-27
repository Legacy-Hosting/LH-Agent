import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRunsCommands } from "../src/core/mode.js";

test("hosting nodes poll and execute commands", () => {
  assert.equal(agentRunsCommands("hosting-node"), true);
});

test("monitor-only nodes never poll for commands", () => {
  assert.equal(agentRunsCommands("monitor-only"), false);
});
