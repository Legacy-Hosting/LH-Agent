import { config } from './config.js'
import { signPayload } from './signature.js'

export async function sendHeartbeat(payload: unknown) {
  const body = JSON.stringify(payload)
  const timestamp = Date.now().toString()
  const response = await fetch(`${config.LH_API_URL}/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LH-Node-ID': config.LH_NODE_ID,
      'X-LH-Timestamp': timestamp,
      'X-LH-Signature': signPayload(config.LH_AGENT_TOKEN, timestamp, body),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) throw new Error(`Heartbeat rejected with status ${response.status}`)
  return response.json()
}
