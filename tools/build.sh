#!/usr/bin/env bash
# Build test: download sources and run makepkg. --nodeps on purpose: the
# container only has base-devel, and -bin packages repackage artifacts.
# Usage: build.sh <package-dir-name>
set -euo pipefail
. "$(dirname "$0")/lib.sh"

dir=${1:?usage: build.sh <package-dir-name>}
cd "$PACKAGES/$dir"
run_as_builder makepkg -f --nodeps --noprogressbar --noconfirm
echo "build: $dir OK"
