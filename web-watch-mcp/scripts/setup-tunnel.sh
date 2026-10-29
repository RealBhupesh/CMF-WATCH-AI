#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: npm run tunnel:setup -- <tunnel-name> <public-hostname> [local-port]" >&2
  echo "Example: npm run tunnel:setup -- job-crawler jobs.example.com 8787" >&2
  exit 1
fi

TUNNEL_NAME="$1"
PUBLIC_HOST="$2"
LOCAL_PORT="${3:-8787}"
CLOUDFLARED_DIR="${HOME}/.cloudflared"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. Run: brew install cloudflared" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to parse cloudflared output." >&2
  exit 1
fi

mkdir -p "${CLOUDFLARED_DIR}"

if [[ ! -f "${CLOUDFLARED_DIR}/cert.pem" ]]; then
  echo "Cloudflare login is required. A browser window will open." >&2
  cloudflared tunnel login
fi

if ! cloudflared tunnel list --name "${TUNNEL_NAME}" --output json | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const tunnels = JSON.parse(input || "[]");
  process.exit(tunnels.length > 0 ? 0 : 1);
});
'; then
  echo "Creating tunnel ${TUNNEL_NAME}" >&2
  cloudflared tunnel create "${TUNNEL_NAME}"
fi

TUNNEL_ID="$(cloudflared tunnel list --name "${TUNNEL_NAME}" --output json | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const tunnels = JSON.parse(input || "[]");
  if (!tunnels[0] || !tunnels[0].id) {
    process.exit(1);
  }
  process.stdout.write(tunnels[0].id);
});
')"

if [[ -z "${TUNNEL_ID}" ]]; then
  echo "Could not determine the tunnel id." >&2
  exit 1
fi

cloudflared tunnel route dns "${TUNNEL_NAME}" "${PUBLIC_HOST}"

cat > "${CLOUDFLARED_DIR}/config.yml" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CLOUDFLARED_DIR}/${TUNNEL_ID}.json

ingress:
  - hostname: ${PUBLIC_HOST}
    service: http://127.0.0.1:${LOCAL_PORT}
  - service: http_status:404
EOF

cat >&2 <<EOF
Tunnel configured.

1. Set MCP_PUBLIC_URL=https://${PUBLIC_HOST} in .env
2. Start the server: npm start
3. Run the tunnel: cloudflared tunnel run ${TUNNEL_NAME}
4. Add this connector URL in ChatGPT: https://${PUBLIC_HOST}/mcp
EOF
