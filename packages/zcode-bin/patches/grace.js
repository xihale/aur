#!/usr/bin/env node
// grace.js — widen the remote replay grace before the relay bridge is torn down.
//
// The host keeps a replay buffer for a disconnected mobile client and tears the
// bridge down terminally once the gap exceeds `replayBufferGraceMs` — hardcoded
// 45e3 in the relay config chunk. Typical mobile interruptions (lockscreen,
// WiFi<->cellular switch) recover within 1-5 minutes, so every such blip forced
// a bridge rebuild, and each rebuild whose resync races the client's V4
// subscription recovery surfaces as `fault.subscription.recoveryFailed` on the
// phone (observed 10-32x/day in ~/.zcode/v2/logs, all replayGraceExceeded).
//
// 600e3 (10 min) covers those; longer gaps need a fresh snapshot anyway
// (replayBufferMaxBytes is 8 MiB), so a wider grace only pins stale memory.
//
// Fail-open like the other patches: warns and continues if the anchor moved;
// verify-build.js asserts the patched value shipped, so a missed anchor still
// fails the build.

"use strict";

const GRACE_RE = /replayBufferGraceMs\s*:\s*45e3\b/g;
const PATCHED = "replayBufferGraceMs:600e3";

function patchFile(path, fs) {
  let src;
  try {
    src = fs.readFileSync(path, "utf8");
  } catch (e) {
    console.error(`zcode-grace-patch: WARNING: cannot read ${path}: ${e.message}`);
    return;
  }
  const live = (src.match(GRACE_RE) || []).length;
  if (live === 0) {
    console.log(
      src.includes(PATCHED)
        ? `zcode-grace-patch: ${path}: already widened`
        : `zcode-grace-patch: ${path}: no replay grace anchor (ok)`
    );
    return;
  }
  try {
    fs.writeFileSync(path, src.replace(GRACE_RE, PATCHED));
    console.log(`zcode-grace-patch: ${path}: widened ${live} replay grace anchor(s) (45s -> 10min)`);
  } catch (e) {
    console.error(`zcode-grace-patch: WARNING: cannot write ${path}: ${e.message}`);
  }
}

function main() {
  const fs = require("fs");
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(js|cjs|mjs)$/.test(name)) patchFile(p, fs);
    }
  };
  for (const arg of process.argv.slice(2)) {
    let st;
    try {
      st = fs.statSync(arg);
    } catch {
      console.error(`zcode-grace-patch: WARNING: missing ${arg}`);
      continue;
    }
    if (st.isDirectory()) walk(arg);
    else patchFile(arg, fs);
  }
}

main();
