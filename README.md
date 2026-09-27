# Legacy Hosting Node Agent

The agent runs on each managed Ubuntu node. It reports system health and PM2 process status to LH-API using a node-specific HMAC signature.

Set `LH_AGENT_MODE=hosting-node` only on servers that may run customer applications. Control-plane servers use `LH_AGENT_MODE=monitor-only`; they report system and PM2 health but never poll for deployments, process operations, log requests, Nginx changes, certificate operations, or persistent-file writes.

The agent reports metrics and executes a narrow set of API-issued commands: deploy, start, stop, restart, delete, configure proxy, renew certificate, and bounded PM2 log snapshots. Commands use a signed node request plus a one-time, expiring lease. There is no arbitrary shell-command endpoint.

Metrics remain on the normal heartbeat interval, while the agent polls the signed command-claim endpoint every two seconds by default. This keeps log snapshots and control actions responsive without collecting expensive system metrics continuously. Configure the intervals with `LH_HEARTBEAT_INTERVAL_MS` and `LH_COMMAND_POLL_INTERVAL_MS`.

Agent `1.x` streams bounded command-output chunks back to the API approximately once per second. The progress response also communicates cancellation. Active child processes are terminated without invoking a shell, temporary credentials still pass through their normal cleanup blocks, and the final result records the command as cancelled instead of failed.

Every v1 request carries a timestamp, one-time nonce, legacy transition signature, and nonce-bound v2 signature. This permits an API-first rolling upgrade without disconnecting old agents. Disable legacy signature acceptance after all nodes report v1.

Each heartbeat includes host load, memory, root-disk usage, cumulative network counters, PM2 CPU/memory state, and cached application-directory size. Managed Nginx virtual hosts use a per-domain access log; the agent reads only completed new lines and reports response bytes as application traffic. Read offsets survive restarts in `/var/lib/legacy-hosting-agent/traffic-offsets.json`.

Deployments validate that application paths have the exact `/home/ROOT.DOMAIN/FULL.HOSTNAME` shape, use argument-based process spawning without a shell, obtain a short-lived repository-scoped GitHub token, run the detected package workflow, and start the process through PM2 with panel-managed environment values. Deleted application directories are moved to recoverable `.lh-trash-*` paths instead of being recursively erased.

Proxy commands require Linux and root privileges. They use Certbot DNS-01 with a short-lived customer Cloudflare OAuth token, remove the temporary token file after every attempt, generate only hostname-validated files under `/etc/nginx/conf.d`, run `nginx -t`, and roll the config back if validation fails. Deleting an application also removes its managed Nginx config and Certbot lineage.

## Local development

Copy `.env.example` to `.env`, configure a development node ID and token, then run `pnpm install` and `pnpm dev`.

The mode is part of node enrollment and must match the mode registered by LH-API. Changing only the local environment cannot promote a monitoring agent into a hosting node.

## Production

Tags named `v*` publish an immutable archive and checksum to `LH-Releases/LH-Agent`. Promote that verified archive on the API server with `LH-Ops/scripts/install-agent-distribution.sh`. The Panel-generated installation command then downloads the active archive and installs it beneath `/opt/legacy-hosting-agent/releases`.

The node must have Git, Nginx, the Certbot Snap plus `certbot-dns-cloudflare`, Node.js 24 LTS, PM2, and the package manager detected for the application (`npm`, `pnpm`, `yarn`, or `bun`). The current server baseline already includes npm and pnpm. Run the agent as root until a dedicated service account and tightly scoped privilege policy are introduced.
