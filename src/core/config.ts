import 'dotenv/config'
import { z } from 'zod'

export const config = z.object({
  LH_API_URL: z.string().url().transform((value) => value.replace(/\/$/, '')),
  LH_NODE_ID: z.string().uuid(),
  LH_AGENT_TOKEN: z.string().min(32),
  LH_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(10_000).max(300_000).default(30_000),
}).parse(process.env)
