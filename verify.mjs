// Node.js smoke test — loads synth.wasm and exercises the same
// interface the AudioWorkletProcessor uses. Runs headlessly so we
// can verify the WASM side before touching a browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(__dir, "host/synth.wasm"));

const enosys = () => 52;
const badf = () => 8;
const ok = () => 0;

const imports = {
  webaudio: { sin: Math.sin },
  wasi_snapshot_preview1: {
    fd_write: ok,
    clock_time_get: ok,
    proc_exit: (code) => {
      if (code !== 0) throw new Error("proc_exit(" + code + ")");
    },
    random_get: () => 0,
    path_open: enosys,
    fd_read: enosys,
    fd_close: ok,
    fd_seek: enosys,
    fd_filestat_get: enosys,
    path_filestat_get: enosys,
    path_create_directory: enosys,
    path_rename: enosys,
    path_unlink_file: enosys,
    path_remove_directory: enosys,
    fd_prestat_get: badf,
    fd_prestat_dir_name: badf,
    fd_readdir: enosys,
    environ_sizes_get: (pc, pbs) => {
      const view = new DataView(memory.buffer);
      view.setInt32(pc, 0, true);
      view.setInt32(pbs, 0, true);
      return 0;
    },
    environ_get: () => 0,
    args_sizes_get: (pc, pbs) => {
      const view = new DataView(memory.buffer);
      view.setInt32(pc, 0, true);
      view.setInt32(pbs, 0, true);
      return 0;
    },
    args_get: () => 0,
  },
};

const mod = new WebAssembly.Module(bytes);
const instance = new WebAssembly.Instance(mod, imports);
const memory = instance.exports.memory;
const ex = instance.exports;

console.log("== exports ==");
console.log(
  Object.keys(ex)
    .map((k) => `  ${k}: ${typeof ex[k] === "function" ? "fn" : typeof ex[k]}`)
    .join("\n"),
);

console.log("\n== _start ==");
if (ex._start) {
  ex._start();
  console.log("  ok");
} else {
  console.log("  (no _start)");
}

console.log("\n== hello() ==");
if (typeof ex.hello === "function") {
  const h = ex.hello();
  console.log("  → " + h + (h === 42 ? "  ok" : "  FAIL expected 42"));
} else {
  console.log("  MISSING: hello not exported");
  process.exit(1);
}
const helloOk = ex.hello() === 42;

console.log("\n== synth_sample ==");
if (typeof ex.synth_sample !== "function") {
  console.log("  MISSING: synth_sample not exported");
  process.exit(1);
}

// Generate 1 second of audio at 48 kHz, 220 Hz, 8 harmonics.
// Verify: finite, non-silent, in [-1, 1], per-sample cost reasonable.
const sr = 48000;
const freq = 220;
const harmonics = 8; // Float, no BigInt
const twoPi = Math.PI * 2;
const delta = (twoPi * freq) / sr;

let phase = 0;
let min = Infinity;
let max = -Infinity;
let sumSq = 0;
let nonFinite = 0;

const frames = sr; // 1 second
const t0 = process.hrtime.bigint();
for (let i = 0; i < frames; i++) {
  const s = ex.synth_sample(phase, harmonics);
  if (!Number.isFinite(s)) nonFinite++;
  if (s < min) min = s;
  if (s > max) max = s;
  sumSq += s * s;
  phase += delta;
  if (phase > twoPi) phase -= twoPi;
}
const t1 = process.hrtime.bigint();
const elapsedMs = Number(t1 - t0) / 1e6;
const nsPerCall = (Number(t1 - t0) / frames);
const rms = Math.sqrt(sumSq / frames);

console.log(`  frames:       ${frames} @ ${sr} Hz`);
console.log(`  non-finite:   ${nonFinite}`);
console.log(`  min:          ${min.toFixed(4)}`);
console.log(`  max:          ${max.toFixed(4)}`);
console.log(`  peak:         ${Math.max(Math.abs(min), Math.abs(max)).toFixed(4)}`);
console.log(`  rms:          ${rms.toFixed(4)}`);
console.log(`  elapsed:      ${elapsedMs.toFixed(2)} ms  (${(elapsedMs / 1000 * 100).toFixed(2)}% of 1s realtime)`);
console.log(`  per call:     ${nsPerCall.toFixed(0)} ns`);

// AudioWorklet runs process() every 128/48000 = 2.667 ms
const budgetUs = (128 / sr) * 1e6;
const perBlockUs = nsPerCall * 128 / 1000;
console.log(`\n  AudioWorklet budget: ${budgetUs.toFixed(0)} µs per 128-frame block`);
console.log(`  per-block cost:      ${perBlockUs.toFixed(0)} µs  (${(perBlockUs / budgetUs * 100).toFixed(1)}% of budget)`);

// Pass/fail
const ok1 = nonFinite === 0;
const ok2 = rms > 0.01 && rms < 0.5; // actually making sound
const ok3 = Math.max(Math.abs(min), Math.abs(max)) <= 1.0; // won't clip
const ok4 = perBlockUs < budgetUs; // fits budget

console.log("\n== summary ==");
console.log(`  finite output:        ${ok1 ? "PASS" : "FAIL"}`);
console.log(`  audible amplitude:    ${ok2 ? "PASS" : "FAIL"}  (rms ${rms.toFixed(3)})`);
console.log(`  no clip:              ${ok3 ? "PASS" : "FAIL"}`);
console.log(`  realtime budget:      ${ok4 ? "PASS" : "FAIL"}  (${(perBlockUs / budgetUs * 100).toFixed(1)}%)`);

const allPass = ok1 && ok2 && ok3 && ok4;
console.log(`\n  ${allPass ? "ALL GREEN" : "FAILED"}`);
process.exit(allPass ? 0 : 1);
