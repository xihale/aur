#!/usr/bin/env node
// verify-build.js — build-time verification gate (fail-closed).
//
// Runtime blocking is fail-open by design (a desktop app must keep working);
// the build is the one place a human is watching, so a patch that silently
// missed its anchor must fail HERE, not ship. Runs at the end of prepare(),
// before `asar p`:
//
//   node verify-build.js <asar-unpacked-dir> <engine.cjs>
//
// Asserts:
//   1. asar entry swapped to the blocker bootstrap; its recorded realMain exists
//   2. blocker core + bootstrap + rules JSON present in the asar root
//   3. engine carries the lean-patch marker (anchor actually hit)
//   4. zero un-blackholed https://*.aliyuncs.com URLs in app out/ + engine
//   5. replay grace widened by grace.js (600e3 present, no 45e3 residue)
// Bare aliyuncs.com host strings (no scheme) are warnings, not errors: the
// network layer covers them at runtime, but they deserve an eyeball.

"use strict";

const fs = require("fs");
const path = require("path");

const [asarDir, enginePath] = process.argv.slice(2);
if (!asarDir || !enginePath) {
  console.error("usage: node verify-build.js <asar-dir> <engine.cjs>");
  process.exit(1);
}

const errors = [];
const warnings = [];
const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

// 1+2: entry swap, blocker files, rules JSON with a resolvable realMain
let pkg = null;
try {
  pkg = JSON.parse(read(path.join(asarDir, "package.json")));
} catch {}
if (!pkg) errors.push(`package.json unreadable under ${asarDir}`);
if (pkg && pkg.main !== "zcode-block.mjs") {
  errors.push(`asar main is ${JSON.stringify(pkg && pkg.main)}, expected "zcode-block.mjs" — block-install.js did not run?`);
}
for (const f of ["zcode-block.mjs", "zcode-block.cjs", "zcode-block.json"]) {
  if (!fs.existsSync(path.join(asarDir, f))) errors.push(`missing ${f} in asar root`);
}
let cfg = null;
try {
  cfg = JSON.parse(read(path.join(asarDir, "zcode-block.json")));
} catch (e) {
  errors.push(`zcode-block.json unparsable: ${e.message}`);
}
if (cfg) {
  if (!cfg.realMain) errors.push("zcode-block.json has no realMain");
  else if (!fs.existsSync(path.join(asarDir, cfg.realMain)))
    errors.push(`realMain ${cfg.realMain} does not exist inside the asar — upstream moved its entry; block-install recorded a dead path`);
}

// 3: lean patch actually landed in the engine
const engine = read(enginePath);
if (engine === null) errors.push(`engine not readable: ${enginePath}`);
else {
  if (!engine.includes("zcode-lean-patch") || !engine.includes("__zlean?globalThis.__zlean.proc"))
    errors.push("engine has no lean-patch marker — lean.js anchor missed; fail-open must not reach the package");
  // 6: sleep-inhibit wrapper landed on the turn/compact prototype assignments
  if (!engine.includes("zcode-sleep-inhibit-patch") || !engine.includes("__zcodeSleepInhibit.wrap("))
    errors.push("engine has no sleep-inhibit marker — sleep-inhibit.js anchor missed; fail-open must not reach the package");
}

// 4: data-layer blackhole applied everywhere telemetry.js touches
const URL_RE = /https:\/\/[a-z0-9.-]+\.aliyuncs\.com/g;
const HOST_RE = /[a-z0-9.-]+\.aliyuncs\.com/g;
// 5: grace.js widened the relay replay grace (45e3 must be gone, 600e3 present)
const GRACE_OLD_RE = /replayBufferGraceMs\s*:\s*45e3\b/g;
const GRACE_NEW = "replayBufferGraceMs:600e3";
let scanned = 0;
let gracePatched = 0;
let graceResidue = 0;
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(js|cjs|mjs)$/.test(name)) continue;
    scanned++;
    const src = read(p);
    if (src === null) continue;
    const urls = src.match(URL_RE) || [];
    if (urls.length) errors.push(`${p}: ${urls.length} un-blackholed https://*.aliyuncs.com URL(s)`);
    const bare = (src.match(HOST_RE) || []).length - urls.length;
    if (bare > 0) warnings.push(`${p}: ${bare} bare aliyuncs.com host string(s) (network layer covers; eyeball if unexpected)`);
    graceResidue += (src.match(GRACE_OLD_RE) || []).length;
    gracePatched += src.split(GRACE_NEW).length - 1;
  }
};
walk(path.join(asarDir, "out"));
if (graceResidue > 0) errors.push(`${graceResidue} unreplaced replayBufferGraceMs:45e3 anchor(s) in out/ — grace.js did not cover them`);
else if (gracePatched === 0) errors.push("no replayBufferGraceMs:600e3 in out/ — grace.js anchor missed or upstream renamed the config field");
if (engine !== null) {
  const em = engine.match(URL_RE) || [];
  if (em.length) errors.push(`engine: ${em.length} un-blackholed https://*.aliyuncs.com URL(s)`);
  const bare = (engine.match(HOST_RE) || []).length - em.length;
  if (bare > 0) warnings.push(`engine: ${bare} bare aliyuncs.com host string(s)`);
}

for (const w of warnings) console.warn(`verify-build: WARNING: ${w}`);
if (errors.length) {
  console.error(`verify-build: FAILED — ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`verify-build: OK — entry swapped, realMain resolves, lean + sleep-inhibit markers in engine, replay grace widened (${gracePatched} anchor(s)), ${scanned} app files + engine free of un-blackholed telemetry URLs`);
