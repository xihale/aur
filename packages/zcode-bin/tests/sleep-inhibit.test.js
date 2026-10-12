"use strict";
// sleep-inhibit.test.js — fixture tests for patches/sleep-inhibit.js: variant
// anchors wrap + the runtime genuinely takes/releases the inhibitor child
// (ZCODE_SLEEP_INHIBIT_CMD shim, offline), env off switch, idempotency, fail-open.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PATCH = path.join(__dirname, "..", "patches", "sleep-inhibit.js");
const run = (file, env = []) =>
  spawnSync(process.execPath, [PATCH, file], { encoding: "utf8", env: { ...process.env, ...Object.fromEntries(env.map((kv) => kv.split("=", 2))) } });

let pass = 0;
const ok = (n) => {
  pass++;
  console.log(`  ✓ ${n}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-inhibit-test-"));
try {
  // 1. anchors wrap + injected runtime takes/releases a real child end-to-end
  const f1 = path.join(tmp, "engine.js");
  fs.copyFileSync(path.join(__dirname, "fixtures", "sleep-ok.js"), f1);
  const marker = path.join(tmp, "shim-marker");
  const r1 = run(f1);
  if (r1.status !== 0) throw new Error(`patch failed: ${r1.stderr}`);
  const patched = fs.readFileSync(f1, "utf8");
  if (!patched.includes("__zcodeSleepInhibit.wrap(x7q)")) throw new Error("turn wrapper missing");
  if (!patched.includes("__zcodeSleepInhibit.wrap(kbt)")) throw new Error("compact wrapper missing");
  if (!patched.startsWith("#!")) throw new Error("shebang lost");
  const e2e = spawnSync(process.execPath, [f1, marker], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      ZCODE_SLEEP_INHIBIT_CMD: `echo started >> ${JSON.stringify(marker)}; exec sleep 30`,
    },
  });
  if (e2e.status !== 0) throw new Error(`e2e run exited ${e2e.status}: ${e2e.stderr}`);
  const line = e2e.stdout.trim();
  if (line !== "e2e result=ok:a held=true shim=true n2=2 midAlive=true released=true compact=compact:b") {
    throw new Error(`e2e: ${JSON.stringify(line)}`);
  }
  ok("锚点 wrap + 引用计数/子进程真启停端到端(turn 期间持锁、嵌套计数、settle 后释放)");

  // 2. env off switch: same fixture runs with the inhibitor disabled
  const f2 = path.join(tmp, "engine-off.js");
  fs.copyFileSync(path.join(__dirname, "fixtures", "sleep-ok.js"), f2);
  run(f2);
  const marker2 = path.join(tmp, "shim-marker-2");
  const off = spawnSync(process.execPath, [f2, marker2], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ZCODE_SLEEP_INHIBIT: "0", ZCODE_SLEEP_INHIBIT_CMD: `echo started >> ${JSON.stringify(marker2)}` },
  });
  if (off.status !== 0) throw new Error(`off run exited ${off.status}: ${off.stderr}`);
  if (off.stdout.trim() !== "e2e result=ok:a held=false shim=false n2=0 midAlive=false released=true compact=compact:b") {
    throw new Error(`off: ${JSON.stringify(off.stdout)}`);
  }
  ok("ZCODE_SLEEP_INHIBIT=0 关闭(不 spawn hold, 语义照常)");

  // 3. idempotent
  const r3 = run(f1);
  if (r3.status !== 0 || !/已打过补丁/.test(r3.stdout)) throw new Error("not idempotent");
  ok("幂等跳过");

  // 4. missing anchor → fail-open: exit 0, file untouched
  const f4 = path.join(tmp, "no-anchor.js");
  fs.copyFileSync(path.join(__dirname, "fixtures", "sleep-no-anchor.js"), f4);
  const before = fs.readFileSync(f4, "utf8");
  const r4 = run(f4);
  if (r4.status !== 0) throw new Error(`fail-open must exit 0, got ${r4.status}`);
  if (fs.readFileSync(f4, "utf8") !== before) throw new Error("fail-open modified the file");
  ok("无锚点 fail-open(exit 0, 文件不动)");

  console.log(`\n${pass}/4 全过`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
