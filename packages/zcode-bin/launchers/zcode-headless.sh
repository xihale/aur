#!/bin/bash
# zcode-headless: run ZCode's agent backend without the Electron GUI.
#
# ZCode Desktop is an Electron app: a GUI (renderer + GPU + window chrome) plus a
# Node "host" backend that does the actual AI agent work. The backend ships as a
# standalone Node bundle at /usr/lib/zcode/glm/zcode.cjs and speaks a JSON-RPC
# protocol over stdio ("app-server" mode), so it runs fine without any GUI.
#
#   zcode-headless                      # app-server on stdio (for RPC clients)
#   zcode-headless prompt "do X"        # one-shot prompt, prints result
#   zcode-headless tui                  # terminal UI (needs sea runtime, may not exist)
#   zcode-headless serve [port]         # stdio server bridged to a TCP port
#   zcode-headless doctor               # runtime diagnostics
#
# Memory: the full GUI stack measures ~3.8 GB RSS total (main + gpu + renderer +
# host + cli + repl helpers). The headless app-server alone idles around
# 0.35-0.4 GB. Sessions and login are shared with the desktop app via ~/.zcode.
set -euo pipefail

_APPDIR="/usr/lib/zcode"
_CLI="${_APPDIR}/glm/zcode.cjs"

if [[ ! -f "${_CLI}" ]]; then
    echo "zcode-headless: cannot find ${_CLI} (is zcode-bin installed?)" >&2
    exit 1
fi

export NODE_ENV=production
# Privacy: hard-opt the engine out of OpenTelemetry export (belt for zcode-telemetry-patch.js)
export ZCODE_MODEL_TELEMETRY_ENABLED="${ZCODE_MODEL_TELEMETRY_ENABLED:-0}"
# Privacy: declarative network blocklist injected into this process and children
export NODE_OPTIONS="--require ${_APPDIR}/zcode-block.cjs${NODE_OPTIONS:+ ${NODE_OPTIONS}}"

cmd="${1:-app-server}"
case "${cmd}" in
    app-server|doctor|version|commands|login|logout|plugins|skills)
        # app-server defaults to stdio transport
        if [[ "${cmd}" == "app-server" ]]; then
            [[ $# -gt 0 ]] && shift || true
            exec node "${_CLI}" app-server --stdio "$@"
        fi
        exec node "${_CLI}" "$@"
        ;;
    prompt)
        shift
        # One-shot prompt: uses ~/.zcode/cli/config.json for model auth.
        exec node "${_CLI}" --prompt "$*"
        ;;
    tui)
        shift
        exec node "${_CLI}" tui "$@"
        ;;
    serve)
        port="${2:-8819}"
        if ! command -v socat >/dev/null 2>&1; then
            echo "zcode-headless serve requires socat (pacman -S socat)" >&2
            exit 1
        fi
        echo "ZCode app-server listening on 127.0.0.1:${port} (JSON-RPC, one line per message)"
        # One long-lived server; each TCP connection gets its own stdio session.
        exec socat TCP-LISTEN:"${port}",bind=127.0.0.1,reuseaddr,fork \
            EXEC:"node ${_CLI} app-server --stdio"
        ;;
    help|--help|-h)
        sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    *)
        echo "unknown command: ${cmd} (see zcode-headless help)" >&2
        exit 1
        ;;
esac
