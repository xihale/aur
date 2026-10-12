#!/usr/bin/env node
// zcode-telemetry-patch.js — blackhole ZCode's phone-home telemetry endpoints.
//
// Audit (see 09-egress-telemetry-audit): the app ships two telemetry channels, both
// hardwired to one Aliyun SLS host, with no UI switch and no functional env override:
//   1. ARMS RUM  https://proj-xtrace-….log.aliyuncs.com/rum/web/v2      (perf_network_window,
//      15-min daily-active "view" heartbeat, web-remote-control funnel events; device_mid + account userId)
//   2. ARMS OTLP https://proj-xtrace-….log.aliyuncs.com/apm/trace/opentelemetry
//      (engine "zcode-cli-agent" trace export, packaged-default env in chunk-DBVOEQ2Z)
// Events carry metadata only (timings, funnel outcomes, device_mid) — never file contents —
// but it phones home unconditionally. This patch rewrites the host to 127.0.0.1 so every
// sender fails fast on the loopback with zero packets leaving the machine; all senders
// already catch+warn, so nothing else changes.
//
// Applied as a regex over the vendor host suffix so an upstream project-id or
// subdomain rename is still caught. Broadened to every *.aliyuncs.com URL (SLS
// telemetry, OSS upload endpoints — audit found no legitimate Aliyun traffic);
// anything dynamically served (e.g. OSS hosts from credential responses) is the
// network blocker's job, this is only the data-level backstop.
// Fail-open: warns and continues if nothing matches (same policy as the other patches).

"use strict";

const SLS_HOST_RE = /https:\/\/[a-z0-9.-]+\.aliyuncs\.com/g;
const REPLACEMENT = "http://127.0.0.1";

function patchFile(path, fs) {
  let src;
  try {
    src = fs.readFileSync(path, "utf8");
  } catch (e) {
    console.error(`zcode-telemetry-patch: WARNING: cannot read ${path}: ${e.message}`);
    return;
  }
  const live = (src.match(SLS_HOST_RE) || []).length;
  if (live === 0) {
    console.log(
      src.includes(REPLACEMENT)
        ? `zcode-telemetry-patch: ${path}: already blackholed`
        : `zcode-telemetry-patch: ${path}: no SLS endpoint (ok)`,
    );
    return;
  }
  try {
    fs.writeFileSync(path, src.replace(SLS_HOST_RE, REPLACEMENT));
    console.log(`zcode-telemetry-patch: ${path}: blackholed ${live} telemetry endpoint(s)`);
  } catch (e) {
    console.error(`zcode-telemetry-patch: WARNING: cannot write ${path}: ${e.message}`);
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
      console.error(`zcode-telemetry-patch: WARNING: missing ${arg}`);
      continue;
    }
    if (st.isDirectory()) walk(arg);
    else patchFile(arg, fs);
  }
}

main();
