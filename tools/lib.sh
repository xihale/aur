#!/usr/bin/env bash
# Shared helpers for the aur monorepo tooling. Source, don't execute.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES="$ROOT/packages"
TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

# aur_name <dir> — AUR package name: meta.aur_name override, else first pkgname in .SRCINFO, else PKGBUILD
aur_name() {
	local dir=$1
	local override
	override=$(jq -r '.aur_name // empty' "$PACKAGES/$dir/meta.json" 2>/dev/null)
	if [ -n "$override" ]; then
		echo "$override"
		return
	fi
	local n
	n=$(awk '/^pkgname =/{print $3; exit}' "$PACKAGES/$dir/.SRCINFO" 2>/dev/null)
	if [ -z "$n" ]; then
		n=$(sed -n 's/^pkgname=\(.*\)$/\1/p' "$PACKAGES/$dir/PKGBUILD" | head -1)
	fi
	[ -n "$n" ] || die "cannot resolve package name for $dir"
	echo "$n"
}

# current_pkgver <dir>
current_pkgver() {
	sed -n 's/^pkgver=\(.*\)$/\1/p' "$PACKAGES/$1/PKGBUILD" | head -1
}

# git_identity_args — commit identity, overridable via env
git_identity_args() {
	printf ' -c user.name=%q -c user.email=%q' \
		"${GIT_AUTHOR_NAME:-${GITHUB_ACTOR:-xihale}}" \
		"${GIT_AUTHOR_EMAIL:-${GITHUB_ACTOR:-xihale}@users.noreply.github.com}"
}

# local_pkgbuild_files <dir> — files in <dir> the PKGBUILD refers to by name
# (install script, non-downloaded sources), one per line, existing only.
# Sourced per-CARCH like mksums.sh so variables resolve; stderr is ignored.
local_pkgbuild_files() {
	local dir=$1 f
	( cd "$dir" && CARCH=x86_64 bash -c '
		source ./PKGBUILD >/dev/null 2>&1 || exit 0
		if [ -n "${install:-}" ]; then printf "%s\n" "$install"; fi
		if declare -p source >/dev/null 2>&1; then
			for e in "${source[@]}"; do
				case $e in
					*://*|*::*) ;;
					*) printf "%s\n" "$e" ;;
				esac
			done
		fi
	' ) | while IFS= read -r f; do
		if [ -f "$dir/$f" ]; then printf '%s\n' "$f"; fi
	done || true
}

# push_retry remote ref — push, rebasing once per retry when the remote moved
# (validate.yml regenerates index.json on main, racing the release commit).
push_retry() {
	local tries=3 branch
	while [ "$tries" -gt 0 ]; do
		git push -q "$@" && return 0
		tries=$((tries - 1))
		[ "$tries" -gt 0 ] || return 1
		branch=$(git symbolic-ref --short HEAD) || return 1
		echo "push: rejected, rebasing onto origin/$branch and retrying" >&2
		git pull -q --rebase --autostash origin "$branch" || return 1
	done
}

# run_as_builder cmd... — makepkg refuses to run as root; CI runs as root
run_as_builder() {
	if [ "$(id -u)" = 0 ]; then
		sudo -u builder "$@"
	else
		"$@"
	fi
}
