#!/usr/bin/env node
"use strict";
// fixture: mimics the bundle's prototype-assignment shape for sleep-inhibit.js —
// shebang, minified var names, comma-chained assignments inside a register fn.
function x7q(e, t, n, o) { return new Promise(function (res) { setTimeout(function () { res("ok:" + e); }, 600); }); }
function kbt(e) { return new Promise(function (res) { setTimeout(function () { res("compact:" + e); }, 100); }); }
function reg(t) { t.executeTurnCommand = x7q, t.executeManualCompact = kbt; }
var proto = {};
reg(proto);
var markerFile = process.argv[2];
(async function () {
  var z = globalThis.__zcodeSleepInhibit, st = z._st;
  var pending = proto.executeTurnCommand.call({}, "a");
  await new Promise(function (r) { setTimeout(r, 400); });
  var held = st.n === 1 && !!st.child && st.child.exitCode === null;
  var shim = require("fs").existsSync(markerFile);
  var rel2 = z.acquire();
  var n2 = st.n;
  rel2();
  var midAlive = !!st.child && st.child.exitCode === null;
  var out = await pending;
  var released = false;
  for (var i = 0; i < 50; i++) {
    if (!st.child || st.child.exitCode !== null) { released = true; break; }
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  var compactOk = await proto.executeManualCompact.call({}, "b");
  console.log("e2e result=" + out + " held=" + held + " shim=" + shim + " n2=" + n2 + " midAlive=" + midAlive + " released=" + released + " compact=" + compactOk);
  process.exit(0);
})().catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
