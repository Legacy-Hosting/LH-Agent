import { createHash, createHmac } from "node:crypto";

export function signPayload(token: string, timestamp: string, body: string) {
  const key = createHash("sha256").update(token).digest();
  return createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
}

export function signPayloadV2(
  token: string,
  timestamp: string,
  nonce: string,
  body: string,
) {
  const key = createHash("sha256").update(token).digest();
  return createHmac("sha256", key)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest("hex");
}
