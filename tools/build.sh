#!/usr/bin/env bash
# Build test: download sources and run makepkg. --nodeps on purpose: the
# container only has base-devel, and -bin packages repackage artifacts.
# Usage: build.sh <package-dir-name>
set -euo pipefail
. "$(dirname "$0")/lib.sh"

dir=${1:?usage: build.sh <package-dir-name>}
cd "$PACKAGES/$dir"
# CI runs as root: makepkg below uses --nodeps (the container has only
# base-devel and -bin packages repackage artifacts), which skips the
# dependency checks but still needs the build toolchain present.
if [ "$(id -u)" = 0 ]; then
	deps=$(awk '/^[ \t]*(make|check)depends = /{sub(/^[ \t]*(make|check)depends = /, ""); print}' .SRCINFO 2>/dev/null | sort -u)
	if [ -n "$deps" ]; then
		pacman -S --noconfirm --needed --asdeps $deps
	fi
fi
run_as_builder makepkg -f --nodeps --noprogressbar --noconfirm
echo "build: $dir OK"
