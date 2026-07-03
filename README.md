# audio-poc — Almide → AudioWorklet proof of concept

> The smallest possible demo that rings a speaker with **Almide-compiled
> WASM running inside a browser `AudioWorkletProcessor`**. Purpose: prove
> the pipeline works end-to-end and measure the binary size.

## Status: proven end-to-end

- **Headless WASM**: `node verify.mjs` — all green
- **Real browser**: confirmed audible on macOS Chrome via `./serve.sh` +
  `http://localhost:8765/` (2026-04-11)

| Metric | Result |
|---|---|
| `synth.wasm` size | **2,637 bytes** |
| Exports | `memory`, `_start`, `__alloc`, `hello`, `synth_sample` |
| `hello()` round-trip | returns `42.0` (no Result wrapping) |
| `synth_sample` per call | **142 ns** |
| 128-frame block cost | **18 µs / 2,667 µs budget** (0.7%) |
| Realtime headroom | ~140× |
| Clipping | none (peak ±0.25) |
| RMS | 0.131 (audible) |

Takeaway: Almide's direct WASM emit fits an 8-harmonic additive
synthesizer in under 3 KB and uses less than 1% of the AudioWorklet
budget at 48 kHz — even with naive per-sample FFI (no batching, no
SIMD, no `@realtime` enforcement). A batched version would drop this
by another ~100×.

## What's in here

```
audio-poc/
├── almide.toml            package manifest
├── src/
│   └── main.almd          Almide synth source (~30 LOC)
├── host/
│   ├── index.html         UI (play button + freq/harmonics/volume sliders)
│   ├── app.js             main thread: AudioContext, load worklet, wire UI
│   ├── synth-worklet.js   audio thread: compiles WASM, runs process()
│   └── synth.wasm         ← build output
├── build.sh               almide build --target wasm
├── serve.sh               localhost static server (port 8765)
└── README.md              this file
```

## The pattern being proved

```
   Almide source (src/main.almd)
           │
           │  almide build --target wasm
           ▼
   synth.wasm (direct emit, no wasm-bindgen)
           │
           │  fetch() on main thread
           ▼
   AudioContext
           │
           │  port.postMessage(wasmBytes) into worklet
           ▼
   AudioWorkletGlobalScope  (dedicated audio thread)
           │
           │  new WebAssembly.Module/Instance (sync)
           ▼
   process(_, outputs)  ← called ~375×/sec, 128 samples each
           │
           │  for each sample: wasm.synth_sample(phase, harmonics)
           ▼
   Speakers
```

## Build

```bash
./build.sh
```

Requires `almide` on PATH. If not installed:
```bash
cd ../almide && make install   # builds to ~/.local/bin/almide
```

Output:
```
Built: host/synth.wasm (xxxx bytes)
```

## Run

```bash
./serve.sh
# → open http://localhost:8765/
```

Click **Play**. You should hear a sawtooth-like tone around 220 Hz.
Move the sliders — frequency, harmonic count, and volume all update in
real time without restarting audio.

## Almide source (abridged)

```almide
// Host-provided math (Math.sin via @extern)
@extern(wasm, "webaudio", "sin")
fn sin(x: Float) -> Float

effect fn main() -> Unit = {}

effect fn hello() -> Int = 42

// Pure computation, no alloc — safe in AudioWorklet.process()
effect fn synth_sample(phase: Float, harmonics: Int) -> Float = {
  var i = 1
  var s = 0.0
  while i <= harmonics {
    let k = int.to_float(i)
    s = s + sin(phase * k) / k
    i = i + 1
  }
  s * 0.15
}
```

## What this proves (if it rings)

1. **Almide's direct WASM emit loads and runs inside AudioWorkletGlobalScope.**
   No wasm-bindgen, no glue code, no bundler — just a raw `.wasm` file
   compiled once and sync-instantiated on the audio thread.
2. **FFI bandwidth is sufficient for per-sample DSP.** With 48,000
   `synth_sample()` calls per second, the process() callback still
   clears the 2.6 ms budget. A batched version would push this much
   further.
3. **Host imports give us transcendentals cheaply.** `Math.sin` from
   the worklet global scope comes through `@extern(wasm, "webaudio", "sin")`
   identically to how `obsid` imports `sin`/`cos`/`sqrt`.
4. **The source reads like ordinary Almide.** No special DSL, no
   attribute incantations — the synth is 12 lines of pure function.
5. **Binary size stays tiny.** `synth.wasm` should land somewhere
   around 2–4 KB. Compare to the smallest Rust+wasm-bindgen equivalent
   (~50 KB).

## What this does not yet prove

- **Batched process()**. We call WASM per sample. A real DSP library
  would process 128 samples in one call (`render(ptr, n)`). Deferred
  to `almide/wasm-webaudio` Stage 1.
- **`@realtime` effect marker**. The "no alloc / no IO" property is
  true by construction here, not enforced by the compiler. Deferred
  to Audio Initiative Stage 3.
- **WASM SIMD**. Current codegen is scalar. FIR/FFT/convolution are
  slower than they need to be. Stage 4.
- **Pure-Almide math**. `sin` comes from the host. A lookup-table or
  polynomial approximation in Almide would sever that last JS dep.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `build.sh` fails with "almide not on PATH" | `cd ../almide && make install` |
| Browser shows "preload failed" | Run `./build.sh` first |
| Clicks Play but hears nothing | Check the browser allowed autoplay; unmute the tab |
| `synth.wasm` is huge (>20 KB) | Almide compiler version too old; rebuild |
| Worklet error: `synth_sample is not a function` | The WASM doesn't export `synth_sample`. Check `src/main.almd`'s `effect fn synth_sample` is top-level and not nested |
| Worklet error: `sin is not a function` | Import name mismatch. Should be `@extern(wasm, "webaudio", "sin")` → `imports.webaudio.sin = Math.sin` in worklet |
| `instantiate` error "mismatched import" | Almide runtime requires a WASI import we didn't stub. Check the error message, add the missing stub to `_instantiate` in `host/synth-worklet.js` |

## Gotchas hit during bring-up (and the fixes)

These are recorded here because they are not obvious from the `wasm-canvas`
and `obsid` examples and will bite anyone else trying the same path.

### `effect fn` wraps returns in `Result<T, String>` — DO NOT use it for audio

First iteration used `effect fn hello() -> Int = 42`. The function
returned `528`, not `42`. Inspecting memory at offset 528 showed:

```
[tag:u32 = 0 (Ok)][value:i64 = 42]
```

i.e. Almide allocated a `Result<Int, String>` struct on the heap and
returned a pointer to it. Same for `effect fn synth_sample -> Float`
— returned a pointer to `[tag:u32][value:f64]`.

**Fix**: use plain `pub fn`. It returns primitives directly via WASM's
native ABI (f64 → JS Number, no wrapping, no allocation per call).

```almide
pub fn synth_sample(phase: Float, harmonics: Float) -> Float = ...
```

### `Int` maps to WASM `i64` — JS requires BigInt for params/returns

First iteration had `harmonics: Int`. Calling `synth_sample(phase, 8)`
from JS threw `TypeError: Cannot convert 8 to a BigInt`. Almide's `Int`
is 64-bit, and the WASM JS API requires `i64` values to be passed as
BigInt.

**Fix**: use `Float` for any parameter crossing the JS boundary in a
hot path. BigInt conversion at 48,000 calls/sec is measurable overhead
(~50 ns each), but more importantly it complicates the worklet code.

```almide
pub fn synth_sample(phase: Float, harmonics: Float) -> Float = ...
```

The in-function loop uses `var i: Float` too, so no `int.to_float`
conversion is needed.

### WASI imports Almide emits even for pure programs

Even though the synth does no IO, the runtime imports the full WASI
preview-1 surface: `fd_write`, `clock_time_get`, `proc_exit`,
`random_get`, `path_*`, `fd_*`, `environ_*`, `args_*`. All need stubs
in the imports object. See `host/synth-worklet.js#_instantiate` for
the minimal set. Missing any one causes "mismatched import" at
instantiate time.

`environ_sizes_get` / `args_sizes_get` must actually write zeros to
the output pointers — they can't be pure no-ops, or the Almide runtime
reads uninitialized memory.

## Next steps if the demo works

1. **Measure**: record the WASM size, CPU usage at 48 kHz, and
   compare against a Rust+wasm-bindgen port of the same synth.
2. **Batch**: add `synth_block(out_ptr: Int, n: Int, ...)` that
   writes 128 samples per call. Drops FFI overhead by 128×.
3. **Stage 2 showcase**: Schroeder reverb in pure Almide, aim for
   ≤ 5 KB WASM. If it clears 2.6 ms budget, we have the full story.
4. **Promote**: `audio-poc/` → `almide/wasm-webaudio` package.

## Related

- `/AUDIO_INITIATIVE.md` — full roadmap this PoC is Stage 0 of
- `/CAPABILITY_MAP.md` §6 C6 — strategic framing
- `almide/wasm-canvas` — template this PoC was modeled after
- `almide/obsid` — template for host-imported math (`sin`/`cos`/`sqrt`)
