"use strict";
// audit-diff.js — review a ZCODE_BLOCK_AUDIT capture for policy drift.
//
// Sections:
//   allowed hosts  — what the rules DON'T know; a new telemetry vendor hides here
//   blocked hosts  — rule confirmation
// Exits 1 on lines that contradict the current rules (a "blocked" host no rule
// matches, or an "allow" a rule should have caught — means capture and rules
// came from different versions).
const fs = require("fs");
const path = require("path");

process.env.ZCODE_BLOCK_NO_AUTOSTART = "1";
const core = require(path.join(__dirname, "..", "runtime", "block.cjs"));

const file = process.argv[2];
if (!file) {
  console.error("usage: node audit-diff.js <capture-file>");
  process.exit(1);
}
let lines;
try {
  lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
} catch (e) {
  console.error(`audit-diff: cannot read ${file}: ${e.message}`);
  process.exit(1);
}

const rules = { ...core.DEFAULT_RULES };
const allowed = new Map();
const blocked = new Map();
const anomalies = [];
for (const line of lines) {
  const tab = line.indexOf("\t");
  if (tab === -1) {
    anomalies.push(`${line}  (unparsable)`);
    continue;
  }
  const host = line.slice(0, tab);
  const verdict = line.slice(tab + 1);
  const rule = core.matchRule(rules, host, "");
  if (verdict === "blocked" && !rule) anomalies.push(`${line}  (blocked but no rule matches)`);
  else if (verdict === "allow" && rule) anomalies.push(`${line}  (allowed despite rule)`);
  else if (rule) blocked.set(host, (blocked.get(host) || 0) + 1);
  else allowed.set(host, (allowed.get(host) || 0) + 1);
}

console.log("— 允许放行的 host（策略盲区,重点看有无新遥测厂商）—");
for (const [h, n] of allowed) console.log(`  ${h}  ×${n}`);
console.log("— 已被规则拦截的 host —");
for (const [h, n] of blocked) console.log(`  ${h}  ×${n}`);

if (anomalies.length) {
  console.error(`\naudit-diff: ${anomalies.length} 条记录与当前规则矛盾（捕获与规则版本不一致?）:`);
  for (const a of anomalies) console.error(`  ${a}`);
  process.exit(1);
}
console.log(`\naudit-diff: ${allowed.size} allowed / ${blocked.size} blocked — 规则未覆盖的 host 逐条过目后,需要的话改 runtime/block.cjs 的 DEFAULT_RULES`);
