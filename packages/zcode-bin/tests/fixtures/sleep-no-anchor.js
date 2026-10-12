#!/usr/bin/env node
"use strict";
// fixture: NO prototype-assignment anchor for sleep-inhibit.js — the patcher
// must fail-open (exit 0, file byte-identical).
function turnImpl() { return Promise.resolve("ok"); }
var proto = { executeTurnCommand: turnImpl };
proto.executeTurnCommand.call({}, "a").then(function (v) {
  console.log("e2e result=" + v);
});
