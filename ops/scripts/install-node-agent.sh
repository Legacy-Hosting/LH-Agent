#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

api_url=https://api.legacyhosting.xyz/api/v1
node_id=
node_token=
agent_mode=hosting-node

usage() {
  echo "Usage as root: $0 --node-id UUID --token TOKEN [--mode hosting-node|monitor-only] [--api-url HTTPS_URL]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      api_url=$2
      shift 2
      ;;
    --node-id)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      node_id=$2
      shift 2
      ;;
    --token)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      node_token=$2
      shift 2
      ;;
    --mode)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      agent_mode=$2
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer through sudo" >&2
  exit 1
fi
if [[ ! $node_id =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  echo "Invalid node ID" >&2
  exit 1
fi
if [[ ! $node_token =~ ^[A-Za-z0-9_-]{32,}$ ]]; then
  echo "Invalid node token" >&2
  exit 1
fi
if [[ $agent_mode != hosting-node && $agent_mode != monitor-only ]]; then
  echo "Agent mode must be hosting-node or monitor-only" >&2
  exit 1
fi
if [[ ! $api_url =~ ^https://[^[:space:]\'\"]+$ ]]; then
  echo "The API URL must use HTTPS" >&2
  exit 1
fi
if [[ ! -r /etc/os-release ]]; then
  echo "This installer requires Ubuntu" >&2
  exit 1
fi
. /etc/os-release
if [[ ${ID:-} != ubuntu ]]; then
  echo "This installer currently supports Ubuntu only" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to run the installer" >&2
  exit 1
fi

environment_file=/etc/legacy-hosting/agent.env
if [[ -e $environment_file ]]; then
  echo "$environment_file already exists; move it to a protected backup before re-enrolling this server" >&2
  exit 1
fi

temporary_directory=$(mktemp -d)
staging_directory=
cleanup() {
  rm -rf -- "$temporary_directory"
  if [[ -n $staging_directory && -d $staging_directory ]]; then
    rm -rf -- "$staging_directory"
  fi
}
trap cleanup EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git nginx snapd

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')
fi
if [[ $node_major != 24 ]]; then
  curl --proto '=https' --tlsv1.2 -fsSLo "$temporary_directory/nodesource.sh" \
    https://deb.nodesource.com/setup_24.x
  bash "$temporary_directory/nodesource.sh"
  apt-get install -y nodejs
fi

npm install --global --no-audit --no-fund pnpm@12.4.1 pm2@7.0.4
systemctl enable --now nginx

if ! snap list core >/dev/null 2>&1; then
  snap install core
fi
snap refresh core
if dpkg-query -W -f='${Status}' certbot 2>/dev/null | grep -q "install ok installed"; then
  apt-get remove -y certbot
fi
if ! snap list certbot >/dev/null 2>&1; then
  snap install --classic certbot
fi
ln -sfn /snap/bin/certbot /usr/bin/certbot
snap set certbot trust-plugin-with-root=ok
if ! snap list certbot-dns-cloudflare >/dev/null 2>&1; then
  snap install certbot-dns-cloudflare
fi

runtime_url="${api_url%/}/agent/runtime.tar.gz"
checksum_url="${runtime_url}.sha256"
curl --proto '=https' --tlsv1.2 -fsSLo "$temporary_directory/lh-agent-runtime.tar.gz" "$runtime_url"
curl --proto '=https' --tlsv1.2 -fsSLo "$temporary_directory/lh-agent-runtime.tar.gz.sha256" "$checksum_url"
(cd "$temporary_directory" && sha256sum --check lh-agent-runtime.tar.gz.sha256)
runtime_checksum=$(awk 'NR==1 {print $1}' "$temporary_directory/lh-agent-runtime.tar.gz.sha256")
if [[ ! $runtime_checksum =~ ^[a-f0-9]{64}$ ]]; then
  echo "Invalid agent runtime checksum" >&2
  exit 1
fi

base=/opt/legacy-hosting-agent
release="$base/releases/${runtime_checksum:0:16}"
install -d -m 0755 "$base/releases"
if [[ ! -d $release ]]; then
  staging_directory=$(mktemp -d "$base/releases/.staging.XXXXXX")
  tar -xzf "$temporary_directory/lh-agent-runtime.tar.gz" --no-same-owner \
    --strip-components=1 -C "$staging_directory"
  for path in package.json pnpm-lock.yaml pnpm-workspace.yaml ecosystem.config.cjs dist/index.js; do
    if [[ ! -e "$staging_directory/$path" ]]; then
      echo "The agent runtime is missing $path" >&2
      exit 1
    fi
  done
  pnpm --dir "$staging_directory" install --prod --frozen-lockfile
  chown -R root:root "$staging_directory"
  chmod 0755 "$staging_directory"
  mv "$staging_directory" "$release"
  staging_directory=
fi

install -d -m 0700 /etc/legacy-hosting
temporary_environment=$(mktemp /etc/legacy-hosting/.agent.env.XXXXXX)
{
  printf "LH_API_URL='%s'\n" "$api_url"
  printf "LH_NODE_ID='%s'\n" "$node_id"
  printf "LH_AGENT_TOKEN='%s'\n" "$node_token"
  printf "LH_AGENT_MODE='%s'\n" "$agent_mode"
  printf "LH_HEARTBEAT_INTERVAL_MS='30000'\n"
  printf "LH_COMMAND_POLL_INTERVAL_MS='2000'\n"
} > "$temporary_environment"
chmod 0600 "$temporary_environment"
mv "$temporary_environment" "$environment_file"

ln -sfn "$release" "$base/current"
ln -sfn "$environment_file" "$base/current/.env"
pm2 startOrReload "$base/current/ecosystem.config.cjs" --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null
pm2 describe lh-agent >/dev/null

echo "Legacy Hosting node agent installed and started."
echo "Return to the panel and wait for the node status to change to online."
