import "dotenv/config";
import { z } from "zod";
import { agentModes } from "./mode.js";

export const config = z
  .object({
    LH_API_URL: z
      .string()
      .url()
      .transform((value) => value.replace(/\/$/, "")),
    LH_NODE_ID: z.string().uuid(),
    LH_AGENT_TOKEN: z.string().min(32),
    LH_AGENT_MODE: z.enum(agentModes).default("hosting-node"),
    LH_HEARTBEAT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(300_000)
      .default(30_000),
    LH_COMMAND_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(30_000)
      .default(2_000),
  })
  .parse(process.env);
