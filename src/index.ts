import { collectPm2Processes } from './collectors/pm2.js'
import { collectSystemMetrics } from './collectors/system.js'
import { sendHeartbeat } from './core/api.js'
import { config } from './core/config.js'

let stopping = false

async function heartbeat() {
  const [system, processes] = await Promise.all([collectSystemMetrics(), collectPm2Processes()])
  await sendHeartbeat({ agentVersion: '0.1.0', sentAt: new Date().toISOString(), system, processes })
}

async function run() {
  console.log(`Legacy Hosting Agent 0.1.0 started for node ${config.LH_NODE_ID}`)
  while (!stopping) {
    const started = Date.now()
    try {
      await heartbeat()
      console.log(`${new Date().toISOString()} heartbeat sent`)
    } catch (error) {
      console.error(`${new Date().toISOString()} heartbeat failed`, error instanceof Error ? error.message : error)
    }
    const remaining = Math.max(1_000, config.LH_HEARTBEAT_INTERVAL_MS - (Date.now() - started))
    await new Promise((resolve) => setTimeout(resolve, remaining))
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopping = true })
}

await run()
