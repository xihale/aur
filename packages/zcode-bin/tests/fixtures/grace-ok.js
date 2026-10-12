// Fixture shaped after the real relay config chunk (chunk-C6VCYWB4.js, 3.14.3):
// minified object literal, the grace anchor between unrelated numeric fields.
var m = { saturationHighWaterMarkBytes: 1024 * 1024, saturationLowWaterMarkBytes: 256 * 1024, replayBufferMaxBytes: 8 * 1024 * 1024, replayBufferGraceMs: 45e3, assemblyTimeoutMs: 3e4 };
function C(n, e) { if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${e} must be a positive integer`); return n; }
console.log("grace:", m.replayBufferGraceMs);
