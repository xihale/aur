"use strict";
// lean.test.js — fixture tests for patches/lean.js: variant anchors, idempotency,
// end-to-end env gating, fail-open. Fixtures are copied to a temp dir, never
// mutated in place.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LEAN = path.join(__dirname, "..", "patches", "lean.js");
const run = (file, env = {}) =>
  spawnSync(process.execPath, [LEAN, file], { encoding: "utf8", env: { ...process.env, ...env } });

let pass = 0;
const ok = (n) => {
  pass++;
  console.log(`  ✓ ${n}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lean-test-"));
try {
  // 1. variant anchor patches cleanly AND the injected hook gates end-to-end
  const f1 = path.join(tmp, "engine.js");
  fs.copyFileSync(path.join(__dirname, "fixtures", "lean-ok.js"), f1);
  const r1 = run(f1);
  if (r1.status !== 0) throw new Error(`patch failed: ${r1.stderr}`);
  const patched = fs.readFileSync(f1, "utf8");
  if (!patched.includes("__zlean?globalThis.__zlean.proc")) throw new Error("wrapper missing");
  if (!patched.startsWith("#!")) throw new Error("shebang lost");
  const bare = spawnSync(process.execPath, [f1], { encoding: "utf8" });
  if (bare.status !== 0) throw new Error(`bare run exited ${bare.status}: ${bare.stderr}`);
  if (bare.stdout.trim() !== "tools: 1") throw new Error(`bare run: ${JSON.stringify(bare.stdout)}`);
  const deny = spawnSync(process.execPath, [f1], {
    encoding: "utf8",
    env: { ...process.env, ZCODE_TOOLS_DENY: "ping" },
  });
  if (deny.status !== 0) throw new Error(`deny run exited ${deny.status}: ${deny.stderr}`);
  if (deny.stdout.trim() !== "tools: 0") throw new Error(`deny run: ${JSON.stringify(deny.stdout)}`);
  ok("变体锚点(空白+非 .call 形状)打补丁 + __zlean 钩子端到端生效(裸跑 1 / DENY 0)");

  // 2. second run is a no-op
  const r2 = run(f1);
  if (r2.status !== 0 || !/已打过补丁/.test(r2.stdout)) throw new Error("not idempotent");
  ok("幂等跳过");

  // 3. missing anchor → fail-open: exit 0, file untouched
  const f2 = path.join(tmp, "no-anchor.js");
  fs.copyFileSync(path.join(__dirname, "fixtures", "lean-no-anchor.js"), f2);
  const before = fs.readFileSync(f2, "utf8");
  const r3 = run(f2);
  if (r3.status !== 0) throw new Error(`fail-open must exit 0, got ${r3.status}`);
  if (fs.readFileSync(f2, "utf8") !== before) throw new Error("fail-open modified the file");
  ok("无锚点 fail-open(exit 0, 文件不动)");

  console.log(`\n${pass}/3 全过`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
