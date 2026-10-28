#!/usr/bin/env bash
# Publish a package: mirror monorepo files to the AUR git repo (if aur=true)
# and commit everything back to the monorepo.
#
# Env:
#   GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL  commit identity (default from GITHUB_ACTOR or xihale)
#   CI=1                                push monorepo to origin instead of local remote
#
# Usage: publish.sh <package-dir-name>
set -euo pipefail
. "$(dirname "$0")/lib.sh"

dir=${1:?usage: publish.sh <package-dir-name>}
pdir="$PACKAGES/$dir"
[ -f "$pdir/PKGBUILD" ] || die "no PKGBUILD for $dir"

aur=$(jq -r '.aur // false' "$pdir/meta.json")
ver="$(current_pkgver "$dir")-$(sed -n 's/^pkgrel=\(.*\)$/\1/p' "$pdir/PKGBUILD" | head -1)"
ident_args=($(git_identity_args))
AUR_URL=${AUR_URL:-ssh://aur@aur.archlinux.org}

# --- monorepo staging, before anything is pushed ------------------------
cd "$ROOT"
# Tracked changes only (bump touches PKGBUILD + .SRCINFO), plus new local
# files the PKGBUILD names (install scripts, patches). Downloaded sources
# are never added: they are large — AUR rejects blobs over 488K — and
# makepkg fetches them anyway.
git add -u -- "packages/$dir"
mapfile -t local_src < <(local_pkgbuild_files "$pdir")
if [ ${#local_src[@]} -gt 0 ]; then
	git add -f -- "${local_src[@]/#/packages/$dir/}"
fi
# Safety net for remote sources tracked before the rule above existed.
mapfile -t remote_src < <(awk -v p="packages/$dir" '
	function emit(s) {
		if (s ~ /::/) sub(/::.*/, "", s)
		else {
			sub(/[?#].*/, "", s)
			sub(/.*\//, "", s)
			sub(/\.git$/, "", s)
		}
		if (s != "") print p "/" s
	}
	/^[ \t]*source[a-zA-Z0-9_]* = / && /:\/\/|::/ {
		s = $0
		sub(/^[ \t]*source[a-zA-Z0-9_]* = /, "", s)
		emit(s)
	}' "$PACKAGES/$dir/.SRCINFO" 2>/dev/null)
if [ ${#remote_src[@]} -gt 0 ]; then
	git rm -q --cached --ignore-unmatch "${remote_src[@]}"
fi
# Refuse to publish a blob the AUR will reject: fail here, not after the
# push bounces with the blob already in monorepo history.
big=()
while IFS= read -r -d '' f; do
	[ -f "$f" ] || continue
	if [ "$(stat -c %s -- "$f")" -gt 490000 ]; then big+=("$f"); fi
done < <(git diff --cached --name-only -z --diff-filter=ACMR)
if [ ${#big[@]} -gt 0 ]; then
	die "staged files exceed the AUR blob limit (488 KiB): ${big[*]}"
fi

# --- AUR ----------------------------------------------------------------
if [ "$aur" = true ]; then
	name=$(aur_name "$dir")
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	git clone -q "${AUR_URL}/${name}.git" "$tmp/$name"
	cd "$tmp/$name"
	git rm -rq . 2>/dev/null || true
	find . -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} + 2>/dev/null || true
	(cd "$pdir" && git ls-files) | grep -v '^meta.json$' |
		while IFS= read -r f; do
			mkdir -p "$(dirname "$f")"
			cp "$pdir/$f" "$f"
		done
	git add -A
	if git diff --cached --quiet; then
		echo "publish: AUR $name already up to date"
	else
		git "${ident_args[@]}" commit -qm "upstream release $ver"
		push_retry origin HEAD
		echo "publish: AUR $name -> $ver"
	fi
else
	echo "publish: $dir is aur=false, skipping AUR push"
fi

# --- monorepo commit ----------------------------------------------------
cd "$ROOT"
if ! git diff --cached --quiet; then
	git "${ident_args[@]}" commit -qm "$dir $ver"
	if [ -n "${CI:-}" ]; then
		push_retry origin HEAD
	else
		push_retry
	fi
	echo "publish: monorepo committed $dir $ver"
else
	echo "publish: monorepo already up to date"
fi
