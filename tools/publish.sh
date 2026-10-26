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
		git push -q origin HEAD
		echo "publish: AUR $name -> $ver"
	fi
else
	echo "publish: $dir is aur=false, skipping AUR push"
fi

# Monorepo commit
cd "$ROOT"
git add "packages/$dir"
# Untrack downloaded remote sources (release binaries, tarballs, git
# clones): they are large — AUR rejects blobs over 488K — and makepkg
# fetches them anyway. Local sources (install scripts, patches, icons)
# stay tracked and published.
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
	/^[ \t]*source(_[a-zA-Z0-9]+)? = / && /:\/\/|::/ {
		s = $0
		sub(/^[ \t]*source(_[a-zA-Z0-9]+)? = /, "", s)
		emit(s)
	}' "$PACKAGES/$dir/.SRCINFO" 2>/dev/null)
if [ ${#remote_src[@]} -gt 0 ]; then
	git rm -q --cached --ignore-unmatch "${remote_src[@]}"
fi
if ! git diff --cached --quiet; then
	git "${ident_args[@]}" commit -qm "$dir $ver"
	if [ -n "${CI:-}" ]; then
		git push -q origin HEAD
	else
		git push -q
	fi
	echo "publish: monorepo committed $dir $ver"
else
	echo "publish: monorepo already up to date"
fi
