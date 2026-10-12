#!/usr/bin/env bash
# Generate index.json: github repo -> packages watching it. Consumed by the
# Cloudflare email worker and by the bump workflow.
# Usage: gen-index.sh   (writes $ROOT/index.json)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

nd=$(mktemp)
out=$(mktemp)
trap 'rm -f "$nd" "$out"' EXIT

for d in "$PACKAGES"/*/; do
	d=$(basename "$d")
	jq -c --arg d "$d" '
		select(.watch != null and .watch.github != null)
		| {repo: .watch.github, pkg: $d, tag_to_pkgver: (.watch.tag_to_pkgver // [])}
	' "$PACKAGES/$d/meta.json" >> "$nd"
done

jq -s '
	group_by(.repo)
	| map({(.[0].repo): [.[] | {pkg, tag_to_pkgver}]})
	| add // {}
' "$nd" > "$out"

if [ -f "$ROOT/index.json" ] && jq -e . "$out" >/dev/null && cmp -s "$out" "$ROOT/index.json"; then
	echo "gen-index: index.json unchanged"
else
	mv "$out" "$ROOT/index.json"
	echo "gen-index: index.json updated"
fi
