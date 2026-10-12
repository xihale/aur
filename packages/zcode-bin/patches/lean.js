#!/usr/bin/env node
// lean.js — 给 zcode.cjs 注入 env 门控的工具过滤/描述截断钩子
//
// 用法: node lean.js /path/to/zcode.cjs
// 环境变量(运行 zcode 时生效, 非打补丁时):
//   ZCODE_TOOLS_DENY      逗号分隔工具名黑名单, 支持 * 通配, 如 "Cron*,WebSearch,WebFetch"
//   ZCODE_TOOL_DESC_CAP   工具顶层 description 截断上限(字符), 0/未设=不截断
//   ZCODE_TOOL_SCHEMA_CAP inputSchema 内参数级 description 截断上限(字符), 0/未设=不截断
//
// 行为: 幂等(已打补丁则跳过); 锚点找不到时告警并退出 0(fail-open, 升级构建不炸);
// 写入后跑 node --check 自校验, 失败即回滚原文件。
//
// 锚点策略(教训: 上一版写死了压缩后的调用形状, 上游换个构建就失配):
// 只认属性名 this.cachedTools —— 属性名是语义标识, 压缩器不会改名; 等号右侧的
// 表达式体用括号配平动态截取, 所以压缩函数改名、参数变化、调用方式调整都无关。
// 真失配时优先怀疑: 属性被改名(在 bundle 里 grep cachedTools 看新名字)。
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error(`lean-patch: 目标不存在: ${file || '(未给)'}`);
  process.exit(1);
}

const MARKER = 'zcode-lean-patch';
// 锚点: this.cachedTools===null&&(this.cachedTools=<EXPR>)
const ANCHOR_RE = /this\.cachedTools\s*===\s*null\s*&&\s*\(\s*this\.cachedTools\s*=/g;

const BOOTSTRAP = `/* ${MARKER}: env-gated tool denylist + description cap */
;(function(){var d=(process.env.ZCODE_TOOLS_DENY||"").split(",").map(function(s){return s.trim()}).filter(Boolean).map(function(p){return new RegExp("^"+p.split("*").map(function(s){return s.replace(/[.*+?^\${}()|[\\]\\\\]/g,"\\\\$&")}).join(".*")+"$")});
var cap=parseInt(process.env.ZCODE_TOOL_DESC_CAP||"0",10)||0;
var pcap=parseInt(process.env.ZCODE_TOOL_SCHEMA_CAP||"0",10)||0;
function cut(s,n){if(!n||typeof s!=="string"||s.length<=n)return s;var e=s.lastIndexOf(".",n);if(e<n>>1)e=s.lastIndexOf(" ",n);if(e<n>>1)e=n-1;return s.slice(0,e+1).trimEnd()+"…"}
function walk(o,n,depth){if(!o||typeof o!=="object"||depth>8)return;if(typeof o.description==="string")o.description=cut(o.description,n);for(var k in o){var v=o[k];if(v&&typeof v==="object"){if(Array.isArray(v)){for(var i=0;i<v.length;i++)walk(v[i],n,depth+1)}else walk(v,n,depth+1)}}}
globalThis.__zlean={deny:function(n){return d.some(function(r){return r.test(n)})},cut:cut,proc:function(a){if(!d.length&&!cap&&!pcap)return a;var out=a.filter(function(t){return !(t&&t.name&&d.some(function(r){return r.test(t.name)}))});for(var i=0;i<out.length;i++){var t=out[i];if(cap&&t&&typeof t.description==="string")t.description=cut(t.description,cap);if(pcap&&t&&t.inputSchema)walk(t.inputSchema,pcap,0)}return out}};
})();
`;

// 从 pos 起做括号配平, 返回表达式结束索引(闭合括号处, 不含)。跳过字符串字面量,
// 防止字面量里的括号干扰计数; 配平失败返回 -1。
function findExprEnd(src, pos) {
  let depth = 1; // 锚点尾端已处于 "&&(" 的括号内
  for (let i = pos; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      if (i >= src.length) return -1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARKER) && src.includes('__zlean?globalThis.__zlean.proc')) {
  console.log('lean-patch: 已打过补丁, 跳过 (幂等)');
  process.exit(0);
}

const sites = [];
let m;
ANCHOR_RE.lastIndex = 0;
while ((m = ANCHOR_RE.exec(src)) !== null) {
  const start = m.index + m[0].length;
  const end = findExprEnd(src, start);
  if (end === -1) {
    console.warn('lean-patch: 锚点处括号配平失败, fail-open 跳过不改文件');
    process.exit(0);
  }
  sites.push({ start, end });
  ANCHOR_RE.lastIndex = end;
}
if (sites.length === 0) {
  console.warn('lean-patch: 未找到 this.cachedTools 赋值锚点, 上游可能已变, fail-open 跳过不改文件');
  process.exit(0);
}

// 每处赋值包一层: EXPR -> (globalThis.__zlean ? __zlean.proc(EXPR) : EXPR)
let body = '';
let last = 0;
for (const s of sites) {
  const expr = src.slice(s.start, s.end);
  body += src.slice(last, s.start) + `(globalThis.__zlean?globalThis.__zlean.proc(${expr}):${expr})`;
  last = s.end;
}
body += src.slice(last);

// 引导段插到 shebang 之后(若有), 否则文件头
if (body.startsWith('#!')) {
  const nl = body.indexOf('\n') + 1;
  body = body.slice(0, nl) + BOOTSTRAP + body.slice(nl);
} else {
  body = BOOTSTRAP + body;
}

fs.writeFileSync(file, body);
// 自校验: 语法可解析 + 两处编辑都在 (node --check 只认 .js/.cjs 等后缀, 怪名先拷一份)
const { execFileSync } = require('child_process');
const checkPath = /\.(cjs|mjs|js)$/.test(file) ? file : file + '.check.cjs';
if (checkPath !== file) fs.copyFileSync(file, checkPath);
try {
  execFileSync(process.execPath, ['--check', checkPath], { stdio: 'pipe' });
} finally {
  if (checkPath !== file) fs.unlinkSync(checkPath);
}
const after = fs.readFileSync(file, 'utf8');
if (!after.includes('__zlean?globalThis.__zlean.proc') || !after.includes(MARKER)) {
  console.error('lean-patch: 写入后自校验失败, 回滚');
  fs.writeFileSync(file, src);
  process.exit(1);
}
console.log(`lean-patch: OK — ${file} (+${body.length - src.length}B, ${sites.length} 处赋值已包裹 __zlean.proc)`);
