#!/usr/bin/env node
// block-install.js — wire the universal network blocker into an unpacked asar.
//
// Usage:
//   node block-install.js <asar-dir> <config-out.json> <block.mjs> <block.cjs>
//
// Structure-independent by design: it reads package.json "main", records that
// entry as "realMain", then repoints "main" at the blocker bootstrap (copied
// into the asar root as zcode-block.mjs). Whatever upstream renames or moves,
// the bootstrap re-enters the app via the recorded entry, so this installer
// just follows package.json — no minified-code anchors anywhere.
//
// Also writes the declarative blocklist as zcode-block.json both into the asar
// root and to <config-out> (used by package() to ship the same rules for the
// NODE_OPTIONS=--require path in /usr/lib/zcode).
//
// Idempotent: safe across repeated builds and re-runs.

"use strict";

const fs = require("fs");
const path = require("path");

// Policy single-sourcing: the shipped rules derive from block.cjs's
// DEFAULT_RULES (the one place rule literals live), not a second copy here.
process.env.ZCODE_BLOCK_NO_AUTOSTART = "1";
const core = require(path.join(__dirname, "..", "runtime", "block.cjs"));

const [asarDir, configOut, mjsSrc, cjsSrc] = process.argv.slice(2);
if (!asarDir || !configOut || !mjsSrc || !cjsSrc) {
  console.error("usage: node block-install.js <asar-dir> <config-out.json> <block.mjs> <block.cjs>");
  process.exit(1);
}

const MAIN = "zcode-block.mjs";
const CORE = "zcode-block.cjs";
const CONFIG = "zcode-block.json";
const pkgPath = path.join(asarDir, "package.json");
const configPath = path.join(asarDir, CONFIG);

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

// Re-run after a previous install: pkg.main already points at the bootstrap,
// so recover realMain from the config we wrote last time instead of ourselves.
let realMain;
if (pkg.main === MAIN && fs.existsSync(configPath)) {
  realMain = JSON.parse(fs.readFileSync(configPath, "utf8")).realMain;
} else {
  realMain = pkg.main;
}
if (!realMain) realMain = "out/main/index.js";

const config = {
  realMain,
  ...core.DEFAULT_RULES,
};

pkg.main = MAIN;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
fs.writeFileSync(configOut, JSON.stringify(config, null, 2) + "\n");
fs.copyFileSync(mjsSrc, path.join(asarDir, MAIN));
fs.copyFileSync(cjsSrc, path.join(asarDir, CORE));

console.log(
  `block-install: main -> ${MAIN} (realMain=${realMain}), ` +
    `blocklist hosts=${config.blockHostSuffix.length} paths=${config.blockPathPrefix.length}`,
);
