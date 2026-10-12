"use strict";
// blocker.test.js — behavior matrix for runtime/block.cjs. Loopback only:
// blocked traffic must die at 127.0.0.1:1, everything else must pass through.
// Lesson from the object-shape bypass bug: a test handler must never exit
// silently — every failure path rejects with a named message.
const assert = require("assert");
const http = require("http");
const net = require("net");
const path = require("path");

const block = require(path.join(__dirname, "..", "runtime", "block.cjs"));
const cfg = block.currentConfig;
let pass = 0;
const ok = (name) => {
  pass++;
  console.log(`  ✓ ${name}`);
};
const isBlockedErr = (e) => /ECONNREFUSED|bad port|fetch failed/i.test(String((e && (e.message || e.code)) || e));

(async () => {
  // 1. matchRule units: trailing dot / subdomain / path prefix / no infix match
  assert(block.matchRule(cfg, "bucket.oss-cn-hangzhou.aliyuncs.com", "/x"), "subdomain");
  assert(block.matchRule(cfg, "x.log.aliyuncs.com.", "/x"), "trailing dot");
  assert(block.matchRule(cfg, "zcode.z.ai", "/api/v1/snapshot/upload-credential"), "path");
  assert(!block.matchRule(cfg, "zcode.z.ai", "/api/v1/chat"), "path passthrough");
  assert(!block.matchRule(cfg, "notaliyuncs.com", "/x"), "suffix is not infix");
  ok("matchRule: 尾点/子域/路径前缀/后缀非中缀");

  // 2. fetch to blocked host → dies
  await fetch("https://test.log.aliyuncs.com/rum/web/v2", { method: "POST" }).then(
    () => {
      throw new Error("blocked fetch succeeded");
    },
    (e) => {
      assert.ok(isBlockedErr(e), "unexpected error: " + e.message);
    },
  );
  ok("fetch → aliyuncs 被拦截");

  // 3. fetch to a live local listener → passes through
  const server = http.createServer((req, res) => res.end("pong"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  assert.strictEqual(await (await fetch(`http://127.0.0.1:${port}/ping`)).text(), "pong");
  ok("fetch → 本地监听放行");

  // 4. http.request with options.host carrying a port suffix → dies
  await new Promise((resolve, reject) => {
    const req = http.request({ host: "x.log.aliyuncs.com:443", path: "/", method: "GET" }, () =>
      reject(new Error("scenario4 connected")),
    );
    req.on("error", (e) => {
      try {
        assert.ok(/ECONNREFUSED/.test(e.code || e.message));
        resolve();
      } catch (a) {
        reject(a);
      }
    });
    req.end();
  });
  ok("http.request(options.host 含端口) 被拦截");

  // 5. net.connect(port, host) legacy shape → dies
  await new Promise((resolve, reject) => {
    const s = net.connect(443, "evil.aliyuncs.com");
    s.on("error", (e) => {
      try {
        assert.ok(/ECONNREFUSED/.test(e.code));
        resolve();
      } catch (a) {
        reject(a);
      }
    });
    s.on("connect", () => reject(new Error("scenario5 connected (port not killed?)")));
  });
  ok("net.connect(port, host) 被拦截");

  // 6. net.connect({host, port}) object shape → dies
  await new Promise((resolve, reject) => {
    const s = net.connect({ host: "oss.aliyuncs.com", port: 443 });
    s.on("error", (e) => {
      try {
        assert.ok(/ECONNREFUSED/.test(e.code));
        resolve();
      } catch (a) {
        reject(a);
      }
    });
    s.on("connect", () => reject(new Error("scenario6 connected (object shape bypass!)")));
  });
  ok("net.connect({host,port}) 被拦截");

  // 7. net.connect to the local listener → passes through
  await new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      resolve();
    });
    s.on("error", reject);
  });
  ok("net.connect 本地放行");

  // 8. policy single home: loadConfig base === exported DEFAULT_RULES
  assert.deepStrictEqual(block.currentConfig.blockHostSuffix, block.DEFAULT_RULES.blockHostSuffix);
  assert.deepStrictEqual(block.currentConfig.blockPathPrefix, block.DEFAULT_RULES.blockPathPrefix);
  ok("DEFAULT_RULES 单源(loadConfig 兜底与导出一致)");

  server.close();
  console.log(`\n${pass}/8 全过`);
})().catch((e) => {
  console.error("FAIL:", e && (e.stack || e.message || e));
  process.exit(1);
});
