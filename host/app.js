// Main thread: creates AudioContext, loads the worklet, wires UI.
//
// The WASM bytes are fetched here and transferred to the worklet via
// processorOptions so the audio thread can compile them synchronously
// inside AudioWorkletGlobalScope.

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
function status(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

let ctx = null;
let node = null;
let gain = null;
let wasmBytes = null;

async function fetchWasm() {
  if (wasmBytes) return wasmBytes;
  const res = await fetch("./synth.wasm");
  if (!res.ok) throw new Error(`fetch synth.wasm: ${res.status}`);
  wasmBytes = await res.arrayBuffer();
  return wasmBytes;
}

async function start() {
  if (node) return;

  ctx = new AudioContext();
  const bytes = await fetchWasm();
  await ctx.audioWorklet.addModule("./synth-worklet.js");

  node = new AudioWorkletNode(ctx, "almide-synth", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      wasmBytes: bytes,
      sampleRate: ctx.sampleRate,
    },
  });

  // Listen for worklet diagnostics (smoke-test result, etc.)
  node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") {
      status(
        `loaded synth.wasm (${bytes.byteLength} B) — hello()=${m.hello} — sr=${ctx.sampleRate} Hz`,
        "ok",
      );
    } else if (m.type === "error") {
      status("worklet error: " + m.message, "err");
    }
  };

  gain = ctx.createGain();
  gain.gain.value = Number($("vol").value) / 100;
  node.connect(gain).connect(ctx.destination);

  sendParams();

  $("play").textContent = "Stop";
  $("play").classList.add("stop");
}

async function stop() {
  if (!node) return;
  try { node.disconnect(); } catch {}
  try { gain.disconnect(); } catch {}
  node = null;
  gain = null;
  if (ctx) await ctx.close();
  ctx = null;
  $("play").textContent = "Play";
  $("play").classList.remove("stop");
  status("stopped");
}

function sendParams() {
  if (!node) return;
  node.port.postMessage({
    freq: Number($("freq").value),
    harmonics: Number($("harm").value),
  });
  if (gain) gain.gain.value = Number($("vol").value) / 100;
}

$("play").addEventListener("click", () => {
  if (node) {
    stop();
  } else {
    start().catch((e) => {
      console.error(e);
      status("start failed: " + e.message, "err");
      stop();
    });
  }
});

$("freq").addEventListener("input", () => {
  $("freq-val").textContent = `${$("freq").value} Hz`;
  sendParams();
});
$("harm").addEventListener("input", () => {
  $("harm-val").textContent = $("harm").value;
  sendParams();
});
$("vol").addEventListener("input", () => {
  $("vol-val").textContent = `${$("vol").value}%`;
  sendParams();
});

// Preload WASM so we can show the size before the user presses Play.
fetchWasm()
  .then((b) => status(`ready — synth.wasm ${b.byteLength} B`, "ok"))
  .catch((e) => status("preload failed: " + e.message, "err"));
