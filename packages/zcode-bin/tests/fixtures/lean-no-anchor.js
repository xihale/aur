// Anchor-miss fixture: lazy init without the `=== null && (...)` shape —
// lean.js must fail-open (exit 0, file untouched).
class Loader {
  constructor() {
    this.cachedTools = null;
  }
  load() {
    if (!this.cachedTools) this.cachedTools = [];
    return this.cachedTools;
  }
}
console.log(new Loader().load().length);
