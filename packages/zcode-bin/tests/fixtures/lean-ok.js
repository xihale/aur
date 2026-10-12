#!/usr/bin/env node
// Synthetic engine fixture: the anchor shape intentionally differs from any
// real bundle (whitespace, non-.call helper) — lean.js must still wrap it,
// and the injected __zlean hook must gate the result end-to-end.
const registry = { buildTools: () => [{ name: "ping" }] };
function helper() {
  return registry.buildTools();
}
class Loader {
  constructor() {
    this.cachedTools = null;
  }
  load() {
    return this.cachedTools === null && (this.cachedTools = helper.call(this, registry.buildTools()));
  }
}
const loader = new Loader();
loader.load();
console.log("tools:", loader.cachedTools.length);
