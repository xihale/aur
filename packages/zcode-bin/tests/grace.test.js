"use strict";
// grace.test.js — fixture tests for patches/grace.js: anchor patch, idempotency,
// fail-open on a moved anchor. Fixtures are copied to a temp dir, never mutated
// in place. The fail-closed side (shipped value must be the patched one) lives
// in verify-build.js, which runs against the real unpacked asar in prepare().
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const GRACE = path.join(__dirname, "..", "patches", "grace.js");
const run = (file) => spawnSync(process.execPath, [GRACE, file], { encoding: "utf8" });

let pass = 0;
const ok = (n) => {
  pass++;
  console.log(`  ✓ ${n}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grace-test-"));
try {
  // 1. anchor patched, value widened, neighbouring config intact
  const f1 = path.join(tmp, "chunk.js");
  fs.copyFileSync(path.join(__dirname, "fixtures", "grace-ok.js"), f1);
  const r1 = run(f1);
  if (r1.status !== 0) throw new Error(`patch failed: ${r1.stderr}`);
  const patched = fs.readFileSync(f1, "utf8");
  if (!patched.includes("replayBufferGraceMs:600e3")) throw new Error("grace not widened");
  if (/replayBufferGraceMs\s*:\s*45e3\b/.test(patched)) throw new Error("45e3 residue left");
  if (!patched.includes("replayBufferMaxBytes")) throw new Error("neighbouring config damaged");
  const exec = spawnSync(process.execPath, [f1], { encoding: "utf8" });
  if (exec.status !== 0 || exec.stdout.trim() !== "grace: 600000") {
    throw new Error(`bare run: status=${exec.status} out=${JSON.stringify(exec.stdout)} err=${exec.stderr}`);
  }
  ok("锚点替换 45e3→600e3 且文件仍可执行(600000), 邻近配置无损");

  // 2. second run is a no-op ("already widened")
  const r2 = run(f1);
  if (r2.status !== 0 || !/already widened/.test(r2.stdout)) throw new Error("not idempotent");
  ok("幂等跳过");

  // 3. missing anchor → fail-open: exit 0, file untouched
  const f2 = path.join(tmp, "no-anchor.js");
  fs.copyFileSync(path.join(__dirname, "fixtures", "grace-no-anchor.js"), f2);
  const before = fs.readFileSync(f2, "utf8");
  const r3 = run(f2);
  if (r3.status !== 0) throw new Error(`fail-open violated: exit ${r3.status}`);
  if (fs.readFileSync(f2, "utf8") !== before) throw new Error("file mutated without anchor");
  if (!/no replay grace anchor/.test(r3.stdout)) throw new Error(`unexpected log: ${r3.stdout}`);
  ok("锚点缺失 fail-open(退出 0, 文件不动)");

  // 4. directory argument walks .js files only
  const dir = path.join(tmp, "out");
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(__dirname, "fixtures", "grace-ok.js"), path.join(dir, "chunk-A.js"));
  fs.writeFileSync(path.join(dir, "keep.txt"), "replayBufferGraceMs:45e3");
  const r4 = run(dir);
  if (r4.status !== 0) throw new Error(`walk failed: ${r4.stderr}`);
  if (!fs.readFileSync(path.join(dir, "chunk-A.js"), "utf8").includes("replayBufferGraceMs:600e3")) {
    throw new Error("walk missed chunk-A.js");
  }
  if (!fs.readFileSync(path.join(dir, "keep.txt"), "utf8").includes("45e3")) {
    throw new Error("non-js file touched");
  }
  ok("目录遍历只处理 js/cjs/mjs, 跳过其他扩展名");

  console.log(`grace.test.js: ${pass} passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
