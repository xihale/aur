#!/usr/bin/env bash
# One-shot local release: optionally bump to a tag, build-test, publish.
# Usage: release.sh <package-dir-name> [tag]
set -euo pipefail
. "$(dirname "$0")/lib.sh"

dir=${1:?usage: release.sh <package-dir-name> [tag]}
if [ $# -ge 2 ]; then
	"$TOOLS/bump.sh" "$dir" "$2" || [ $? -eq 3 ] || exit 1
fi
"$TOOLS/build.sh" "$dir"
"$TOOLS/publish.sh" "$dir"
