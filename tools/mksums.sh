#!/usr/bin/env bash
# Regenerate sha256sums for a package directory, for all architectures.
#
# Why not updpkgsums: it computes checksums for the *running* architecture
# only, so sha256sums_aarch64 / _armv7h / _i686 arrays go stale or vanish.
# This resolves every source array by sourcing the PKGBUILD per-CARCH and
# downloading each artifact (works identically on x86_64 CI and arm hosts).
#
# VCS sources (git+, svn+, ...) get SKIP; local files are left untouched.
# Usage: mksums.sh <package-dir-name-or-path>
set -euo pipefail
. "$(dirname "$0")/lib.sh"

dir=${1:?usage: mksums.sh <package-dir-name-or-path>}
case $dir in
	/*) pkgdir=$dir ;;
	*) pkgdir="$PACKAGES/$dir" ;;
esac
cd "$pkgdir"
[ -f PKGBUILD ] || die "PKGBUILD not found"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Emit "<bucket>\t<entry>" for every source applicable to each CARCH,
# mirroring makepkg's source selection. bucket = any | <carch>.
emit_sources() {
	local c
	for c in x86_64 aarch64 armv7h i686; do
		CARCH=$c bash -c '
			source ./PKGBUILD >/dev/null 2>&1
			match=0
			for a in ${arch[@]}; do
				case $a in any|'"$c"') match=1 ;; esac
			done
			if [ $match = 1 ] && declare -p source >/dev/null 2>&1; then
				for e in ${source[@]}; do printf "any\t%s\n" "$e"; done
			fi
			arr=source_'"$c"'
			if declare -p "$arr" >/dev/null 2>&1; then
				ref="$arr[@]"
				for e in "${!ref}"; do printf "'"$c"'\t%s\n" "$e"; done
			fi
		'
	done
}

# Hash every unique entry -> "<bucket>\t<name>\t<sha256|SKIP>"
: > "$work/map.tsv"
emit_sources | sort -u | while IFS=$'\t' read -r bucket entry; do
	name=${entry%%::*}
	url=$entry
	[ "$entry" = "$name" ] || url=${entry#*::}
	case $url in
		git+*|svn+*|hg+*|bzr+*) h=SKIP ;;
		*://*)
			f="$work/artifact"
			curl -fsSL --retry 2 --retry-delay 2 -o "$f" "$url" || die "download failed: $url"
			h=$(sha256sum "$f" | cut -d' ' -f1)
			;;
		*) continue ;; # local file shipped in the repo, not checksummed
	esac
	printf '%s\t%s\t%s\n' "$bucket" "$name" "$h"
done > "$work/map.raw"
sort -u -o "$work/map.tsv" "$work/map.raw"
[ -s "$work/map.tsv" ] || die "no sources resolved"

# Rewrite the checksum blocks in PKGBUILD.
new=$(mktemp)
awk -v map="$work/map.tsv" '
	BEGIN {
		while ((getline line < map) > 0) {
			split(line, f, "\t")
			m[f[1] SUBSEP f[2]] = f[3]
			if (index(" " order[f[1]] " ", " " f[2] " ") == 0) order[f[1]] = order[f[1]] " " f[2]
		}
	}
	function gen(key, bucket,    indent, n, arr, i, out, nm, hs, q) {
		q = sprintf("%c", 39)
		indent = sprintf("%*s", length(key) + 2, "")
		n = split(order[bucket], arr, " ")
		out = key "=("
		for (i = 1; i <= n; i++) {
			nm = arr[i]; hs = m[bucket SUBSEP nm]
			out = out q hs q
			if (i < n) out = out " \\\n" indent
		}
		return out ")"
	}
	{
		if (!inblk && $0 ~ /^sha256sums(_[a-z0-9_]+)?=\(/) {
			key = $0; sub(/=\(.*/, "", key)
			bucket = (key == "sha256sums") ? "any" : substr(key, index(key, "_") + 1)
			if ($0 ~ /\)[[:space:]]*$/) {        # whole block on one line
				print (bucket in order) ? gen(key, bucket) : $0
				next
			}
			inblk = 1
			buf = $0
			next
		}
		if (inblk) {
			buf = buf "\n" $0
			if ($0 ~ /'\''\)[[:space:]]*$/ || $0 ~ /^\)[[:space:]]*$/) {
				inblk = 0
				print (bucket in order) ? gen(key, bucket) : buf
			}
			next
		}
		print
	}
' PKGBUILD > "$new"
# sanity: generated file must still be valid bash
bash -n "$new" || { echo "mksums: generated PKGBUILD invalid, aborting" >&2; exit 1; }
mv "$new" PKGBUILD
echo "mksums: updated checksums for $pkgdir ($(wc -l < "$work/map.tsv") entries)"
