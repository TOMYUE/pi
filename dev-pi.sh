#!/usr/bin/env bash
# Run pi from this repo's sources with an isolated agent directory.
#
# - Uses packages/coding-agent sources via pi-test.sh (tsx; no build required).
# - Sets PI_CODING_AGENT_DIR to <repo>/.pi-dev/agent by default so auth,
#   settings, sessions, and trust do not touch the global ~/.pi/agent used by
#   an installed `pi` binary.
# - Does not put anything on PATH; global `pi` is unaffected.
#
# Usage (from repo root, or via absolute path from any cwd):
#   ./dev-pi.sh
#   ./dev-pi.sh -p "Say exactly: ok"
#   ./dev-pi.sh --provider deepseek --model deepseek-v4-pro -p "hi"
#
# Optional untracked overrides (gitignored):
#   dev-pi.local.sh          # sourced if present; export API keys / extra env
#   .pi-dev/agent/auth.json  # provider credentials for this isolated agent dir
#   .pi-dev/agent/settings.json
#
# Override the agent dir:
#   PI_CODING_AGENT_DIR=/tmp/pi-agent-scratch ./dev-pi.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$ROOT/.pi-dev/agent}"

mkdir -p "$AGENT_DIR"
export PI_CODING_AGENT_DIR="$AGENT_DIR"

if [[ -f "$ROOT/dev-pi.local.sh" ]]; then
	# shellcheck disable=SC1091
	source "$ROOT/dev-pi.local.sh"
fi

exec "$ROOT/pi-test.sh" "$@"
