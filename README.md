# Legacy Hosting Node Agent

The agent runs on each managed Ubuntu node. It reports system health and PM2 process status to LH-API using a node-specific HMAC signature.

The first version is read-only. Deployment commands, PM2 mutations, certificate issuance, and file operations will be added only through a strict signed job protocol with allowlisted operation types.

## Local development

Copy `.env.example` to `.env`, configure a development node ID and token, then run `pnpm install` and `pnpm dev`.

## Production

Build locally or during a controlled release, copy the release to the node, configure its protected `.env`, then run `pm2 startOrReload ecosystem.config.cjs --update-env`.
