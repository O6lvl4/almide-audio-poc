// AudioWorkletProcessor that runs the Almide WASM synth.
//
// Runs inside AudioWorkletGlobalScope (a dedicated real-time audio thread).
// The WASM module is compiled synchronously here — allowed because the
// module is tiny (a few KB) and we are not in the main thread.
//
// process() is called ~375 times/sec at 48kHz (128 frames per call).
// Every sample in the callback goes through a WASM FFI call to
// synth_sample(phase, harmonics). Phase is kept on the JS side; this is
// the smallest possible pattern that proves the pipeline works, and it
// still clears the 2.6ms-per-callback budget with room to spare.

class AlmideSynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmBytes, sampleRate: sr } =
      (options && options.processorOptions) || {};
    const post = (m) => this.port.postMessage(m);

    try {
      this.wasm = this._instantiate(wasmBytes);
    } catch (e) {
      post({ type: "error", message: "instantiate: " + e.message });
      throw e;
    }

    // WASI convention: call _start once. Runs Almide's top-level main().
    try {
      if (this.wasm._start) this.wasm._start();
    } catch (e) {
      post({ type: "error", message: "_start: " + e.message });
    }

    // Smoke test: confirms JS→WASM FFI round-trip before audio starts.
    let helloResult = null;
    try {
      if (typeof this.wasm.hello === "function") {
        helloResult = this.wasm.hello();
      }
    } catch (e) {
      post({ type: "error", message: "hello: " + e.message });
    }

    // Audio state (JS side — zero allocation inside process()).
    this.phase = 0;
    this.freq = 220;
    this.harmonics = 8;
    this.sampleRate = sr || sampleRate;
    this.twoPi = Math.PI * 2;

    this.port.onmessage = (e) => {
      const { freq, harmonics } = e.data || {};
      if (typeof freq === "number") this.freq = freq;
      if (typeof harmonics === "number") this.harmonics = harmonics | 0;
    };

    post({ type: "ready", hello: helloResult });
  }

  _instantiate(wasmBytes) {
    // Minimal WASI shim — Almide's runtime imports these even when
    // the program performs no IO.
    const enosys = () => 52; // WASI __WASI_ERRNO_NOSYS
    const badf = () => 8;    // WASI __WASI_ERRNO_BADF
    const ok = () => 0;

    const imports = {
      webaudio: {
        sin: Math.sin,
      },
      wasi_snapshot_preview1: {
        fd_write: ok,
        clock_time_get: ok,
        proc_exit: (code) => {
          if (code !== 0) {
            // Surface unexpected aborts, but don't crash the thread.
            this.port.postMessage({
              type: "error",
              message: "proc_exit(" + code + ")",
            });
          }
        },
        random_get: (_buf, _len) => 0,
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
        fd_prestat_get: badf,     // stops preopen scan
        fd_prestat_dir_name: badf,
        fd_readdir: enosys,
        environ_sizes_get: (ptrCount, ptrBufSize) => {
          // Return zero environ + zero buffer size.
          // Some Almide programs call this during startup.
          try {
            const view = new DataView(this.wasm.memory.buffer);
            view.setInt32(ptrCount, 0, true);
            view.setInt32(ptrBufSize, 0, true);
          } catch {}
          return 0;
        },
        environ_get: () => 0,
        args_sizes_get: (pc, pbs) => {
          try {
            const view = new DataView(this.wasm.memory.buffer);
            view.setInt32(pc, 0, true);
            view.setInt32(pbs, 0, true);
          } catch {}
          return 0;
        },
        args_get: () => 0,
      },
    };

    const mod = new WebAssembly.Module(wasmBytes);
    return new WebAssembly.Instance(mod, imports).exports;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const len = out.length;
    const delta = (this.twoPi * this.freq) / this.sampleRate;
    const h = this.harmonics;
    const synth = this.wasm.synth_sample;
    let phase = this.phase;

    for (let i = 0; i < len; i++) {
      out[i] = synth(phase, h);
      phase += delta;
      if (phase > this.twoPi) phase -= this.twoPi;
    }

    this.phase = phase;
    return true;
  }
}

registerProcessor("almide-synth", AlmideSynthProcessor);
