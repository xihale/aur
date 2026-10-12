#!/usr/bin/env node
// sleep-inhibit.js — 给 zcode.cjs 注入"有任务在跑就抑制系统睡眠"的钩子
//
// 用法: node sleep-inhibit.js /path/to/zcode.cjs
//
// 原理: 引擎的 turn 全部经原型方法 this.executeTurnCommand(...)/this.executeManualCompact(...)
// 进入(esbuild 压缩后为 `t.executeTurnCommand=<minified>`, 属性键名是语义标识不会被改名)。
// 在原型装配处把函数值包一层: 调用即 acquire(引用计数+拉起 systemd-inhibit 子进程组持
// logind sleep:idle 阻断锁), settle 即 release。用 .then(rel,rel) 而非逐出口插桩 ——
// turn 有 completed/failed/cancelled 多条出口, 逐点打补丁漏掉一个 release 就是
// 机器永远不睡, 包一层 finally 语义才兜得住。
//
// 孤儿防护(反面比漏 acquire 更严重): hold 子进程组由 /usr/bin/timeout -k 10 21600 封顶,
// 父进程被 SIGKILL 后锁最多再活 6h; 看门狗每 30min 杀旧拉新做续租, 子进程意外死亡也会重拉;
// hold 命令连续秒死 3 次判为环境不可用, 永久静默降级(fail-open, 引擎照常跑)。
//
// 环境变量(运行 zcode 时生效):
//   ZCODE_SLEEP_INHIBIT=0|false|off  关闭(默认开)
//   ZCODE_SLEEP_INHIBIT_DEBUG=1      stderr 打 acquire/release 日志
//   ZCODE_SLEEP_INHIBIT_CMD=<sh -c>  换掉 hold 命令(测试钩子, 单测用它做真启停断言)
//
// 行为: 幂等; 锚点找不到 fail-open 告警退出 0 不改文件(构建不炸, 由 verify-build 拦);
// 写入后 node --check 自校验, 失败即回滚。
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error(`sleep-inhibit-patch: 目标不存在: ${file || '(未给)'}`);
  process.exit(1);
}

const MARKER = 'zcode-sleep-inhibit-patch';
// 锚点: <ident>.executeTurnCommand=<ident> / <ident>.executeManualCompact=<ident>
// lookahead 限定赋值语句收尾符, 避免吃进字符串字面量或比较运算。
const METHODS = ['executeTurnCommand', 'executeManualCompact'];

const BOOTSTRAP = `/* ${MARKER}: logind sleep inhibitor held while a turn/compact runs */
;(function(){
if(globalThis.__zcodeSleepInhibit)return;
var fsq=require("fs"),ccr=require("child_process");
var st={n:0,child:null,born:0,timer:null,ok:true,fails:0,dbg:!!process.env.ZCODE_SLEEP_INHIBIT_DEBUG};
function dbg(m){if(st.dbg)try{process.stderr.write("[zcode-sleep-inhibit] "+m+"\\n")}catch(e){}}
function enabled(){var v=process.env.ZCODE_SLEEP_INHIBIT;return v!=="0"&&v!=="false"&&v!=="off"}
function alive(c){return !!c&&c.exitCode===null&&c.signalCode===null}
function killChild(){
if(st.child){try{st.child.pid&&process.kill(-st.child.pid,"SIGKILL")}catch(e){}try{st.child.kill("SIGKILL")}catch(e){}st.child=null}
st.born=0;
if(st.timer){clearInterval(st.timer);st.timer=null}
}
function hold(){
var cmd=process.env.ZCODE_SLEEP_INHIBIT_CMD;
try{
if(cmd){st.child=ccr.spawn("/bin/sh",["-c",cmd],{stdio:"ignore",detached:true})}
else{
if(!fsq.existsSync("/usr/bin/systemd-inhibit")||!fsq.existsSync("/usr/bin/timeout")){st.ok=false;dbg("no systemd-inhibit/timeout; disabled");return}
st.child=ccr.spawn("/usr/bin/timeout",["-k","10","21600","/usr/bin/systemd-inhibit","--what=sleep:idle","--who=zcode","--why=zcode agent turn running","--mode=block","tail","-f","/dev/null"],{stdio:"ignore",detached:true})
}
}catch(e){st.ok=false;dbg("spawn threw: "+e.message);return}
st.child.on("error",function(){st.ok=false;dbg("hold spawn error; disabled");killChild()});
st.born=Date.now();dbg("hold pid="+st.child.pid)
}
function ensure(){
if(st.n<=0||!st.ok)return;
if(alive(st.child)){
if(Date.now()-st.born>18e5){dbg("lease refresh");try{st.child.pid&&process.kill(-st.child.pid,"SIGKILL")}catch(e){}try{st.child.kill("SIGKILL")}catch(e){}st.child=null}
else{if(Date.now()-st.born>10000)st.fails=0;return}
}
if(st.born&&Date.now()-st.born<10000&&(st.fails+=1)>=3){st.ok=false;dbg("hold cmd keeps dying; disabled");killChild();return}
hold();
if(!st.timer){st.timer=setInterval(function(){try{ensure()}catch(e){}},6e4);if(st.timer.unref)st.timer.unref()}
}
globalThis.__zcodeSleepInhibit={
_st:st,
acquire:function(){
if(!enabled()||!st.ok)return function(){};
st.n++;ensure();dbg("acquire n="+st.n);
var done=false;
return function(){if(done)return;done=true;if(st.n>0)st.n--;dbg("release n="+st.n);if(st.n<=0)killChild()}
}
};
globalThis.__zcodeSleepInhibit.wrap=function(fn){
if(typeof fn!=="function")return fn;
var z=globalThis.__zcodeSleepInhibit;
return function(){
var rel=z.acquire();
try{
var r=fn.apply(this,arguments);
if(r&&typeof r.then==="function")return r.then(function(v){rel();return v},function(e){rel();throw e});
rel();return r
}catch(e){rel();throw e}
}
};
process.on("exit",function(){try{killChild()}catch(e){}})
})();
`;

let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARKER) && src.includes('__zcodeSleepInhibit.wrap(')) {
  console.log('sleep-inhibit-patch: 已打过补丁, 跳过 (幂等)');
  process.exit(0);
}

// 每个方法名的原型赋值都包一层。双处命中同一变量(导出表+原型装配)也无害:
// 双层 wrap 的 acquire/release 成对, 计数仍平。
const sites = [];
for (const method of METHODS) {
  const re = new RegExp(
    `([A-Za-z_$][\\w$]*)\\.${method}\\s*=\\s*([A-Za-z_$][\\w$]*)(?=[,;)\\n}])`,
    'g',
  );
  let m;
  while ((m = re.exec(src)) !== null) {
    sites.push({ index: m.index, text: m[0], fn: m[2] });
  }
}
if (sites.length === 0) {
  console.warn('sleep-inhibit-patch: 未找到 executeTurnCommand/executeManualCompact 原型赋值锚点, 上游可能已变, fail-open 跳过不改文件');
  process.exit(0);
}
// 同一位置只包一次; 偏移基于原 src, 按序拼接
const sorted = [...new Map(sites.map((s) => [s.index, s])).values()].sort((a, b) => a.index - b.index);
let body = '';
let last = 0;
for (const s of sorted) {
  body += src.slice(last, s.index);
  // 纯字符串拼接, 不用正则: 压缩名可含 $, 进正则会变成行尾锚
  const head = s.text.slice(0, s.text.length - s.fn.length);
  body += head + `(globalThis.__zcodeSleepInhibit?globalThis.__zcodeSleepInhibit.wrap(${s.fn}):${s.fn})`;
  last = s.index + s.text.length;
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
} catch (e) {
  console.error('sleep-inhibit-patch: 写入后语法校验失败, 回滚');
  fs.writeFileSync(file, src);
  throw e;
} finally {
  if (checkPath !== file) fs.unlinkSync(checkPath);
}
const after = fs.readFileSync(file, 'utf8');
if (!after.includes(MARKER) || !after.includes('__zcodeSleepInhibit.wrap(')) {
  console.error('sleep-inhibit-patch: 写入后自校验失败, 回滚');
  fs.writeFileSync(file, src);
  process.exit(1);
}
console.log(`sleep-inhibit-patch: OK — ${file} (+${body.length - src.length}B, ${sorted.length} 处方法已包 sleep-inhibit wrap)`);
