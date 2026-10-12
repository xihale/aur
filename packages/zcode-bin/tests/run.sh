#!/usr/bin/env bash
# zcode-bin self-tests. All modes are loopback/offline; `upstream` additionally
# needs the zcode-*.deb corpus in the repo root (gitignored).
#
#   tests/run.sh unit                 blocker shape matrix + lean/sleep-inhibit fixtures (fast;
#                                     also runs via makepkg check())
#   tests/run.sh upstream [ver]       real engines: lean+telemetry against local
#                                     debs, e.g. tests/run.sh upstream 3.12.3 (slow)
#   tests/run.sh audit-diff <file>    review a ZCODE_BLOCK_AUDIT capture for drift
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

case "${1:-unit}" in
  unit)
    /usr/bin/timeout 60 node "${HERE}/blocker.test.js"
    /usr/bin/timeout 60 node "${HERE}/lean.test.js"
    /usr/bin/timeout 60 node "${HERE}/grace.test.js"
    /usr/bin/timeout 60 node "${HERE}/sleep-inhibit.test.js"
    ;;
  upstream)
    want="${2:-}"
    shopt -s nullglob
    for deb in "${ROOT}"/zcode-*.deb; do
      ver=$(basename "$deb" | sed -E 's/^zcode-([0-9.]+)-x86_64\.deb$/\1/')
      [[ -z "$want" || "$ver" == "$want" ]] || continue
      work="$(mktemp -d)"
      bsdtar -xOf "$deb" data.tar.xz | bsdtar -xJf - -C "$work" ./opt/ZCode/resources/glm/zcode.cjs
      engine="${work}/opt/ZCode/resources/glm/zcode.cjs"
      echo "--- ${ver}: lean.js"
      node "${ROOT}/patches/lean.js" "${engine}"
      grep -q '__zlean?globalThis.__zlean.proc' "${engine}"
      echo "--- ${ver}: sleep-inhibit.js"
      node "${ROOT}/patches/sleep-inhibit.js" "${engine}"
      grep -q '__zcodeSleepInhibit.wrap(' "${engine}"
      echo "--- ${ver}: telemetry.js"
      node "${ROOT}/patches/telemetry.js" "${engine}"
      # residue check is the real assertion; telemetry.js itself is fail-open
      ! grep -qE 'https://[a-z0-9.-]+\.aliyuncs\.com' "${engine}"
      rm -rf "${work}"
      echo "--- ${ver}: OK"
    done
    ;;
  audit-diff)
    /usr/bin/timeout 30 node "${HERE}/audit-diff.js" "${2:?usage: tests/run.sh audit-diff <capture-file>}"
    ;;
  *)
    echo "unknown mode: $1 (unit | upstream [ver] | audit-diff <file>)" >&2
    exit 1
    ;;
esac
