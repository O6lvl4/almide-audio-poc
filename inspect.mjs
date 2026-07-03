// Peek at what hello() returns — is 528 a pointer to a Result?
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(__dir, "host/synth.wasm"));

const enosys = () => 52, badf = () => 8, ok = () => 0;
let memory;
const imports = {
  webaudio: { sin: Math.sin },
  wasi_snapshot_preview1: {
    fd_write: ok, clock_time_get: ok, proc_exit: () => {}, random_get: () => 0,
    path_open: enosys, fd_read: enosys, fd_close: ok, fd_seek: enosys,
    fd_filestat_get: enosys, path_filestat_get: enosys,
    path_create_directory: enosys, path_rename: enosys,
    path_unlink_file: enosys, path_remove_directory: enosys,
    fd_prestat_get: badf, fd_prestat_dir_name: badf, fd_readdir: enosys,
    environ_sizes_get: (pc, pbs) => {
      const v = new DataView(memory.buffer); v.setInt32(pc, 0, true); v.setInt32(pbs, 0, true); return 0;
    },
    environ_get: () => 0,
    args_sizes_get: (pc, pbs) => {
      const v = new DataView(memory.buffer); v.setInt32(pc, 0, true); v.setInt32(pbs, 0, true); return 0;
    },
    args_get: () => 0,
  },
};

const mod = new WebAssembly.Module(bytes);
const inst = new WebAssembly.Instance(mod, imports);
memory = inst.exports.memory;
inst.exports._start();

const h = inst.exports.hello();
console.log("hello() =", h, "(" + typeof h + ")");

if (typeof h === "number" && h > 0 && h < memory.buffer.byteLength) {
  const view = new DataView(memory.buffer);
  console.log("\nMemory at offset " + h + " (first 32 bytes):");
  const u8 = new Uint8Array(memory.buffer, h, 32);
  console.log("  bytes:", Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join(" "));
  console.log("  as i32[8]:", Array.from({ length: 8 }, (_, i) => view.getInt32(h + i * 4, true)));
  console.log("  as i64[4]:", Array.from({ length: 4 }, (_, i) => view.getBigInt64(h + i * 8, true).toString()));
  console.log("  as f32[8]:", Array.from({ length: 8 }, (_, i) => view.getFloat32(h + i * 4, true)));
  console.log("  as f64[4]:", Array.from({ length: 4 }, (_, i) => view.getFloat64(h + i * 8, true)));
}

// Also try synth_sample with BigInt arg
try {
  const s = inst.exports.synth_sample(0.5, 8n);
  console.log("\nsynth_sample(0.5, 8n) =", s, "(" + typeof s + ")");
  if (typeof s === "number" && s > 100) {
    const view = new DataView(memory.buffer);
    console.log("  (likely pointer) bytes:", Array.from(new Uint8Array(memory.buffer, s, 24)).map(b => b.toString(16).padStart(2, "0")).join(" "));
    console.log("  as i32[6]:", Array.from({ length: 6 }, (_, i) => view.getInt32(s + i * 4, true)));
    console.log("  as f32[6]:", Array.from({ length: 6 }, (_, i) => view.getFloat32(s + i * 4, true)));
    console.log("  as f64[3]:", Array.from({ length: 3 }, (_, i) => view.getFloat64(s + i * 8, true)));
  }
} catch (e) {
  console.log("\nsynth_sample threw:", e.message);
}
