// zcode-block.mjs — Electron main bootstrap for the declarative network blocklist.
//
// The PKGBUILD swaps package.json "main" (originally out/main/index.js) to this
// file and writes zcode-block.json with the real entry. Structure-independent by
// design: whatever upstream renames, the installer records it in "realMain" and
// this bootstrap re-enters the app after wiring the blocklist.
//
// Order of operations:
//   1. zcode-block.cjs auto-installs on require (node:http(s)/fetch/net/tls/undici).
//   2. Here: also cover the Chromium network stack (renderer, webviews, updater)
//      via session.webRequest — best effort, single-listener API so the app's own
//      registrations may supersede it; the Node layer above is the real gate.
//   3. Dynamically import the real main entry.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const core = require("./zcode-block.cjs"); // auto-installs; install() is idempotent
// Single source of truth for rules: the config the core already loaded
// (defaults + zcode-block.json + ZCODE_BLOCKLIST env merged).
const cfg = core.currentConfig || core.loadConfig();

// Chromium-side enforcement (best effort, see header).
try {
  const electron = require("electron");
  const attach = (ses) => {
    if (!ses || ses.__zcodeBlocked) return;
    try {
      ses.__zcodeBlocked = true;
      ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
        try {
          const u = new URL(details.url);
          const rule = core.matchRule(cfg, u.hostname, u.pathname + u.search);
          if (rule) {
            console.warn(`[zcode-block] blocked ${rule} ${details.url}`);
            callback({ cancel: true });
            return;
          }
        } catch {}
        callback({});
      });
    } catch {}
  };
  if (electron.session?.defaultSession) attach(electron.session.defaultSession);
  else electron.app?.whenReady?.().then(() => attach(electron.session?.defaultSession));
  electron.app?.on?.("session-created", attach);
} catch (e) {
  console.error("[zcode-block] session layer unavailable (fail-open):", e && e.message);
}

// Re-enter the real application.
const realMain = cfg.realMain || "out/main/index.js";
const mainPath = path.join(here, realMain);
if (!existsSync(mainPath)) {
  console.error(
    `[zcode-block] real entry not found: ${mainPath}\n` +
      `[zcode-block] upstream layout changed; block-install.js recorded a stale realMain. ` +
      `The blocker itself is fine — check zcode-block.json.`,
  );
}
await import(pathToFileURL(mainPath).href);
