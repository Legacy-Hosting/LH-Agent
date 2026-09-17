import assert from "node:assert/strict";
import { test } from "node:test";
import { signPayload, signPayloadV2 } from "../src/core/signature.js";

test("legacy signatures remain stable during the rolling upgrade", () => {
  assert.equal(
    signPayload("token", "1700000000000", "{}"),
    "b23cfb7bea446e83494d9c76ee6a706b062c387f2781e5b73c0f5638dde649ba",
  );
});

test("v2 signatures bind the nonce", () => {
  const first = signPayloadV2("token", "1700000000000", "nonce-a", "{}");
  const second = signPayloadV2("token", "1700000000000", "nonce-b", "{}");
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});
