#!/usr/bin/env bash
# Sanity checks run in CI on every push/PR:
#   - all meta.json parse and have sane fields
#   - index.json is fresh (matches gen-index output)
#   - every PKGBUILD parses (bash -n)
# Usage: validate.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"

fail=0
for m in "$PACKAGES"/*/meta.json; do
	d=$(basename "$(dirname "$m")")
	jq -e 'has("aur") and (.aur | type == "boolean")' "$m" >/dev/null \
		|| { echo "invalid: $d/meta.json (missing/invalid 'aur')"; fail=1; }
	gh=$(jq -r '.watch.github // ""' "$m")
	if [ -n "$gh" ] && ! [[ $gh =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
		echo "invalid: $d/meta.json watch.github '$gh'"
		fail=1
	fi
	pk="$PACKAGES/$d/PKGBUILD"
	[ -f "$pk" ] || { echo "missing: $d/PKGBUILD"; fail=1; continue; }
	bash -n "$pk" || { echo "syntax: $d/PKGBUILD"; fail=1; }
	[ -f "$PACKAGES/$d/.SRCINFO" ] || { echo "missing: $d/.SRCINFO"; fail=1; }
	git -C "$ROOT" ls-files --error-unmatch "packages/$d/meta.json" >/dev/null 2>&1 ||
		{ echo "untracked: $d/meta.json (nested .gitignore?)"; fail=1; }
done

"$TOOLS/gen-index.sh" >/dev/null
if ! git -C "$ROOT" diff --quiet -- index.json 2>/dev/null; then
	echo "stale: index.json out of date, run tools/gen-index.sh"
	fail=1
fi

[ $fail = 0 ] && echo "validate: OK"
exit $fail
