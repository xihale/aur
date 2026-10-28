#!/usr/bin/env bash
# Bump a package to an upstream tag: pkgver, pkgrel=1, checksums, .SRCINFO.
# Exit 3 = already at that version (not an error).
# Usage: bump.sh <package-dir-name> <tag>
set -euo pipefail
. "$(dirname "$0")/lib.sh"

dir=${1:?usage: bump.sh <package-dir-name> <tag>}
tag=${2:?usage: bump.sh <package-dir-name> <tag>}
meta="$PACKAGES/$dir/meta.json"
[ -f "$meta" ] || die "no meta.json for $dir"

mapfile -t exprs < <(jq -r '.watch.tag_to_pkgver // [] | .[]' "$meta")
if [ "${#exprs[@]}" -gt 0 ]; then
	newver=$(printf '%s' "$tag" | sed "${exprs[@]}")
else
	newver=$tag
fi
[ -n "$newver" ] || die "tag $tag produced empty pkgver for $dir"

cd "$PACKAGES/$dir"
cur=$(current_pkgver "$dir")
if [ "$newver" = "$cur" ]; then
	echo "skip: $dir already at $newver"
	exit 3
fi

# Stage all mutations; swap in only on success so a failed download
# (bad tag, broken URL) leaves the package untouched.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp PKGBUILD "$work/"
# Local files the PKGBUILD names (install script, shipped sources) must be
# staged too: makepkg --printsrcinfo aborts when $install is missing.
mapfile -t local_files < <(local_pkgbuild_files "$PWD")
for f in ${local_files[@]+"${local_files[@]}"}; do
	install -Dm644 -- "$f" "$work/$f"
done

sed -i "s/^pkgver=.*/pkgver=$newver/" "$work/PKGBUILD"
sed -i 's/^pkgrel=.*/pkgrel=1/' "$work/PKGBUILD"
"$TOOLS/mksums.sh" "$work"
# runner root umask can leave staged files 600; makepkg runs as builder
if [ "$(id -u)" = 0 ]; then chown -R builder:builder "$work"; fi
chmod -R a+rX "$work"
( cd "$work" && run_as_builder makepkg --printsrcinfo > .SRCINFO )
chmod 644 "$work/.SRCINFO"
mv "$work/PKGBUILD" PKGBUILD
mv "$work/.SRCINFO" .SRCINFO

echo "bump: $dir $cur -> $newver"
