"use strict";
// zcode-block.cjs — declarative outbound-network blocklist for ZCode.
//
// Loaded two ways:
//   1. Electron main bootstrap: package.json "main" points at zcode-block.mjs,
//      which installs this core, wires the Chromium session layer, then imports
//      the real app entry (see zcode-block.json "realMain").
//   2. NODE_OPTIONS=--require /usr/lib/zcode/zcode-block.cjs — injected into
//      plain Node children (glm engine, spawned helpers) no matter how their
//      own code evolves.
//
// Design goal (see analysis/09): a GENERAL mechanism, not per-minified-site
// patches. Upstream may restructure anything; every outbound request funnels
// through a handful of stable platform APIs and this file sits on all of them:
//   node:http/https request objects, global fetch, undici (fetch/request/
//   Client/Pool/Agent via a require hook), raw net/tls sockets, and the
//   Chromium session for renderer traffic. Blocked requests are transparently
//   redirected to 127.0.0.1:1 — i.e. instant ECONNREFUSED, indistinguishable
//   from the network being down, so callers follow their normal error paths.
//
// Rules live in zcode-block.json next to this file; extend at runtime with
// ZCODE_BLOCKLIST=<json>. The rule literals themselves have exactly one home:
// DEFAULT_RULES below — patches/block-install.js derives the shipped JSON from
// it, so an installed system and a bare environment can't diverge silently.
// ZCODE_BLOCK_AUDIT=<path> records every classified outbound host (opt-in) for
// policy-drift review via tests/run.sh audit-diff.
// Everything fails open: if this file misbehaves, the worst case is that
// blocking stops, never that the app breaks. (The BUILD is the fail-closed
// place — patches/verify-build.js asserts coverage there, where a human watches.)

const fs = require("fs");
const path = require("path");

const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 1;

// Single policy home. Change rules HERE (the installer picks it up); the
// zcode-block.json on disk is generated output, editable only as a stopgap.
const DEFAULT_RULES = {
  blockHostSuffix: ["aliyuncs.com"],
  blockPathPrefix: ["/api/v1/snapshot/"],
};

function loadConfig() {
  const base = DEFAULT_RULES;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(__dirname, "zcode-block.json"), "utf8"));
  } catch {}
  let env = {};
  try {
    if (process.env.ZCODE_BLOCKLIST) env = JSON.parse(process.env.ZCODE_BLOCKLIST);
  } catch {}
  const cfg = { ...base, ...file, ...env };
  cfg.debug = !!process.env.ZCODE_BLOCK_DEBUG;
  cfg._lastLog = new Map();
  return cfg;
}

// host suffix + path prefix matcher; returns the matched rule or null.
function matchRule(cfg, host, path) {
  host = String(host || "").toLowerCase().replace(/\.$/, ""); // FQDN trailing dot
  path = String(path || "/");
  for (const s of cfg.blockHostSuffix || []) {
    if (host === s || host.endsWith("." + s)) return "host:" + s;
  }
  for (const p of cfg.blockPathPrefix || []) {
    if (path.startsWith(p)) return "path:" + p;
  }
  return null;
}

function logBlock(cfg, rule, detail) {
  if (cfg.debug) {
    console.warn(`[zcode-block] blocked ${rule} ${detail}`);
    return;
  }
  const now = Date.now();
  if (now - (cfg._lastLog.get(rule) || 0) < 60000) return;
  cfg._lastLog.set(rule, now);
  console.warn(`[zcode-block] blocking outbound ${rule} (e.g. ${detail}; ZCODE_BLOCK_DEBUG=1 for all)`);
}

// Re-write a blocked target to the loopback dead port, preserving shape.
function redirUrl(u) {
  const x = new URL(u.href);
  x.protocol = "http:";
  x.hostname = REDIRECT_HOST;
  x.port = String(REDIRECT_PORT);
  return x;
}

// Opt-in drift recorder: appends "<host>\t<blocked|allow>" on first sight of a
// classified outbound host per process. Deliberately NOT default-on — this is a
// privacy package and secret logging would be ironic.
const auditSeen = new Set();
function auditHost(host, rule) {
  const file = process.env.ZCODE_BLOCK_AUDIT;
  if (!file || !host) return;
  const line = `${host}\t${rule ? "blocked" : "allow"}`;
  if (auditSeen.has(line)) return;
  auditSeen.add(line);
  try {
    fs.appendFileSync(file, line + "\n");
  } catch {}
}

function install(cfg) {
  const decide = (host, path) => matchRule(cfg, host, path);
  const applyBlocked = (args) => {
    // args follow http.request(url|options[,options][,cb]) shapes; returns true if rewritten.
    let a0 = args[0];
    if (typeof a0 === "string" || a0 instanceof URL) {
      let u;
      try {
        u = new URL(a0 instanceof URL ? a0.href : a0);
      } catch {
        return false;
      }
      const opts = args[1] && typeof args[1] === "object" && !(args[1] instanceof URL) && typeof args[1] !== "function" ? args[1] : null;
      // options.host may carry a port ("host:443") — strip it before matching.
      const host = String((opts && (opts.hostname || opts.host)) || u.hostname).replace(/:\d+$/, "");
      const pth = (opts && opts.path) || u.pathname + u.search;
      const rule = decide(host, pth);
      auditHost(host, rule);
      if (!rule) return false;
      logBlock(cfg, rule, u.href);
      const red = redirUrl(u);
      args[0] = red;
      if (opts) {
        opts.hostname = REDIRECT_HOST;
        opts.port = REDIRECT_PORT;
      }
      return true;
    }
    if (a0 && typeof a0 === "object") {
      const host = a0.hostname || (a0.host ? String(a0.host).replace(/:\d+$/, "") : "");
      const rule = decide(host, a0.path || a0.pathname);
      auditHost(host, rule);
      if (!rule) return false;
      logBlock(cfg, rule, `${host}${a0.path || a0.pathname || ""}`);
      a0.hostname = REDIRECT_HOST;
      a0.host = `${REDIRECT_HOST}:${REDIRECT_PORT}`;
      a0.port = REDIRECT_PORT;
      delete a0.socketPath;
      return true;
    }
    return false;
  };

  // node:http / node:https — patching the module object also covers ESM named
  // imports that resolve to the same builtin singleton. get() rides on request().
  const http = require("http");
  const https = require("https");
  for (const m of [http, https]) {
    if (m.__zcodeBlocked) continue;
    m.__zcodeBlocked = true;
    const orig = m.request;
    m.request = function (...args) {
      try {
        applyBlocked(args);
      } catch {}
      return orig.apply(this, args);
    };
  }

  // global fetch (Node ≥18 / Electron main): property on globalThis, so even
  // callers that did `const {fetch} = globalThis` late still hit the wrapper.
  if (typeof globalThis.fetch === "function" && !globalThis.fetch.__zcodeBlocked) {
    const origFetch = globalThis.fetch;
    const wrapped = function (input, init) {
      try {
        const u = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
        const U = new URL(u);
        const rule = decide(U.hostname, U.pathname + U.search);
        auditHost(U.hostname, rule);
        if (rule) {
          logBlock(cfg, rule, U.href);
          input = redirUrl(U);
        }
      } catch {}
      return origFetch.call(this, input, init);
    };
    wrapped.__zcodeBlocked = true;
    globalThis.fetch = wrapped;
  }

  // Raw sockets: connection-level catch-all for host rules — library-agnostic
  // (covers bundled undici internals, OTLP exporters, anything). Handles all
  // connect() shapes: (options), (port[, host][, cb]), (host, port, cb), (path).
  const net = require("net");
  const tls = require("tls");
  for (const m of [net, tls]) {
    if (m.__zcodeBlocked) continue;
    m.__zcodeBlocked = true;
    for (const fn of ["connect", "createConnection"]) {
      if (typeof m[fn] !== "function") continue;
      const orig = m[fn];
      m[fn] = function (...args) {
        try {
          // classify without blowing up on any shape; host stays null for
          // anything we don't recognize (unix paths, bare ports, callbacks)
          let host = null, opts = null, hostIdx = -1, portIdx = -1;
          if (args[0] && typeof args[0] === "object") {
            opts = args[0];
            host = String(opts.hostname || opts.host || "");
            if (/^[^[\]:]+:\d+$/.test(host)) host = host.slice(0, host.lastIndexOf(":")); // "host:443"
          } else if (typeof args[1] === "string" && /^\d+$/.test(String(args[0]))) {
            host = args[1]; hostIdx = 1; portIdx = 0;
          } else if (typeof args[0] === "string" && typeof args[1] === "number") {
            host = args[0]; hostIdx = 0; portIdx = 1;
          }
          if (host !== null) {
            const rule = matchRule(cfg, host, "");
            auditHost(host, rule);
            if (rule) {
              logBlock(cfg, rule, host);
              if (opts) {
                opts.host = REDIRECT_HOST;
                opts.hostname = REDIRECT_HOST;
                opts.port = REDIRECT_PORT;
              } else {
                args[hostIdx] = REDIRECT_HOST;
                // kill the port too, else traffic lands on 127.0.0.1:<orig-port>,
                // which may be a live local listener
                if (portIdx >= 0) args[portIdx] = REDIRECT_PORT;
              }
            }
          }
        } catch {}
        return orig.apply(this, args);
      };
    }
  }

  // undici (bundled dependency): wrap its public surfaces via a require hook.
  // ESM `import "undici"` inside Electron skips Module._load, but the OSS/OTLP
  // hosts it talks to are already covered by the socket-level rule above.
  const Module = require("module");
  if (!Module._load.__zcodeBlocked) {
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      const exp = origLoad.apply(this, arguments);
      try {
        const isUndici = request === "undici" || (typeof request === "string" && /node_modules[\\/]undici(?:[\\/]|$)/.test(request));
        if (isUndici && exp && !exp.__zcodeBlocked) {
          exp.__zcodeBlocked = true;
          for (const fn of ["fetch", "request"]) {
            if (typeof exp[fn] !== "function") continue;
            const orig = exp[fn];
            exp[fn] = function (...args) {
              try {
                applyBlocked(args);
              } catch {}
              return orig.apply(this, args);
            };
          }
          for (const C of ["Client", "Pool", "Agent"]) {
            const cls = exp[C];
            if (cls && cls.prototype && typeof cls.prototype.dispatch === "function" && !cls.prototype.dispatch.__zcodeBlocked) {
              const orig = cls.prototype.dispatch;
              cls.prototype.dispatch = function (opts, handler) {
                try {
                  if (opts && typeof opts === "object") {
                    const origin = String(opts.origin || "");
                    const U = origin.startsWith("http") ? new URL(origin) : null;
                    const rule = decide(U ? U.hostname : origin, opts.path);
                    auditHost(U ? U.hostname : origin, rule);
                    if (rule) {
                      logBlock(cfg, rule, origin + (opts.path || ""));
                      opts.origin = `http://${REDIRECT_HOST}:${REDIRECT_PORT}`;
                    }
                  }
                } catch {}
                return orig.call(this, opts, handler);
              };
              cls.prototype.dispatch.__zcodeBlocked = true;
            }
          }
        }
      } catch {}
      return exp;
    };
    Module._load.__zcodeBlocked = true;
  }
}

module.exports = { install, loadConfig, matchRule, DEFAULT_RULES };

// Install immediately on load (via --require or plain require). install() is
// idempotent (__zcodeBlocked guards), so a second load is a no-op.
if (process.env.ZCODE_BLOCK_NO_AUTOSTART !== "1") {
  try {
    const cfg = loadConfig();
    module.exports.currentConfig = cfg; // bootstrap (zcode-block.mjs) reuses this
    install(cfg);
  } catch (e) {
    console.error("[zcode-block] install failed (fail-open):", e && e.message);
  }
}
