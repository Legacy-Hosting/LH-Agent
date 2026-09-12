import { execFile } from 'node:child_process'
import { hostname, loadavg, freemem, totalmem, uptime } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function diskUsage() {
  try {
    const { stdout } = await exec('df', ['-Pk', '/'])
    const columns = stdout.trim().split('\n').at(-1)?.split(/\s+/)
    return columns?.[4] ? Number(columns[4].replace('%', '')) : null
  } catch {
    return null
  }
}

export async function collectSystemMetrics() {
  const total = totalmem()
  const free = freemem()
  return {
    hostname: hostname(),
    uptimeSeconds: Math.floor(uptime()),
    loadAverage: loadavg(),
    memoryTotalBytes: total,
    memoryUsedBytes: total - free,
    memoryUsedPercent: Number((((total - free) / total) * 100).toFixed(2)),
    diskUsedPercent: await diskUsage(),
  }
}
