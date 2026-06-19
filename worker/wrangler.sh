#!/usr/bin/env bash
#
# Thin wrapper around wrangler for the bazaar-apk-resolver worker.
# Credentials are read from the environment or backend/.env — never hardcoded.
#
# Usage:
#   ./wrangler.sh verify          # check the API token is valid (curl)
#   ./wrangler.sh whoami          # which account the token can access
#   ./wrangler.sh deploy          # upload worker.js to Cloudflare
#   ./wrangler.sh dev             # local dev server on http://localhost:8787
#   ./wrangler.sh tail            # stream live logs from the deployed worker
#   ./wrangler.sh <anything...>   # passed straight through to wrangler
#
set -euo pipefail

# Always run from the directory this script lives in (where wrangler.toml is).
cd "$(dirname "$0")"

# Load backend/.env if present (lines like KEY=value).
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (export it or put it in backend/.env)}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (export it or put it in backend/.env)}"

# wrangler reads these env vars for non-interactive auth.
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

cmd="${1:-deploy}"

case "$cmd" in
  verify)
    # Direct API check — no wrangler needed. Confirms the token itself is good.
    curl -fsS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    echo
    ;;
  *)
    # Everything else goes to wrangler, run inside Docker (no local node/npx).
    # Build a local image with wrangler baked in (once) so we don't re-download it
    # on every CLI call. Rebuild manually after bumping WRANGLER_VERSION.
    IMAGE="wrangler-local"
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "Building $IMAGE (one-time)…" >&2
      # Build context is docker/ — it holds only the Dockerfile (clean context).
      docker build -t "$IMAGE" docker
    fi
    # Use an interactive TTY only when attached to one (so CI/non-tty still works).
    TTY=""; [[ -t 0 && -t 1 ]] && TTY="-it"
    # -p 8787 is only needed for `dev`, but harmless otherwise.
    docker run --rm $TTY \
      -v "$PWD":/worker -w /worker \
      -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID \
      -p 8787:8787 \
      "$IMAGE" "$@"
    ;;
esac
