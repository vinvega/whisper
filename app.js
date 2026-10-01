// Voice Notes — offline, local Whisper transcription into an editable document.
// Uses Transformers.js (runs the Whisper model fully in the browser; cached for offline use).
import {
  pipeline,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js";

// Allow downloading models from the HF hub on first run; they are then cached
// by the browser (and our service worker) so later runs work offline.
env.allowLocalModels = false;

// Whisper expects 16 kHz mono audio.
const WHISPER_SAMPLE_RATE = 16000;
const STORAGE_KEY = "voice-notes:document";
const MODEL_KEY = "voice-notes:model";

// ---- DOM references ----
const els = {
  statusDot: document.getElementById("statusDot"),
  modelSelect: document.getElementById("modelSelect"),
  exportBtn: document.getElementById("exportBtn"),
  newBtn: document.getElementById("newBtn"),
  status: document.getElementById("status"),
  editor: document.getElementById("editor"),
  saveState: document.getElementById("saveState"),
  wordCount: document.getElementById("wordCount"),
  recordBtn: document.getElementById("recordBtn"),
};

// ---- App state ----
let transcriber = null;      // the loaded Whisper pipeline
let loadingModel = false;
let currentModel = localStorage.getItem(MODEL_KEY) || els.modelSelect.value;

let mediaRecorder = null;
let audioChunks = [];
let recording = false;
let saveTimer = null;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

function setDot(kind) {
  els.statusDot.className = "dot" + (kind ? " " + kind : "");
}

function setRecordingUI(isRecording) {
  els.recordBtn.classList.toggle("recording", isRecording);
  els.recordBtn.setAttribute("aria-pressed", String(isRecording));
  els.recordBtn.querySelector(".record-label").textContent = isRecording
    ? "Stop"
    : "Record";
}

function updateWordCount() {
  const text = els.editor.innerText.trim();
  const words = text ? text.split(/\s+/).length : 0;
  els.wordCount.textContent = `${words} word${words === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Persistence (localStorage, debounced)
// ---------------------------------------------------------------------------
function loadDocument() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) els.editor.innerText = saved;
  updateWordCount();
}

function markSaving() {
  els.saveState.textContent = "Saving…";
  els.saveState.className = "save-state saving";
}

function scheduleSave() {
  markSaving();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, els.editor.innerText);
    els.saveState.textContent = "Saved";
    els.saveState.className = "save-state saved";
  }, 400);
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------
async function ensureModel() {
  if (transcriber && currentModel === els.modelSelect.value) return transcriber;

  // Model changed — rebuild.
  if (currentModel !== els.modelSelect.value) {
    transcriber = null;
    currentModel = els.modelSelect.value;
    localStorage.setItem(MODEL_KEY, currentModel);
  }

  if (loadingModel) {
    // Wait for the in-flight load to finish.
    while (loadingModel) await new Promise((r) => setTimeout(r, 150));
    return transcriber;
  }

  loadingModel = true;
  setDot("loading");
  setStatus(`Loading ${currentModel.split("/")[1]} model (first time downloads once)…`);

  try {
    transcriber = await pipeline("automatic-speech-recognition", currentModel, {
      progress_callback: (p) => {
        if (p.status === "progress" && p.file && typeof p.progress === "number") {
          setStatus(`Downloading ${p.file}: ${Math.round(p.progress)}%`);
        }
      },
    });
    setDot("ready");
    setStatus("Model ready. Click Record to capture an idea.");
  } catch (err) {
    setDot("error");
    setStatus(`Failed to load model: ${err.message}`, "error");
    throw err;
  } finally {
    loadingModel = false;
  }
  return transcriber;
}

// ---------------------------------------------------------------------------
// Audio: record -> decode -> resample to 16kHz mono Float32 -> transcribe
// ---------------------------------------------------------------------------
async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus(`Microphone access denied: ${err.message}`, "error");
    return;
  }

  // Warm up the model while the user starts talking.
  ensureModel().catch(() => {});

  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    await transcribeBlob(blob);
  };

  mediaRecorder.start();
  recording = true;
  setRecordingUI(true);
  setStatus("Recording… click Stop when you're done.", "active");
}

function stopRecording() {
  if (mediaRecorder && recording) {
    mediaRecorder.stop();
    recording = false;
    setRecordingUI(false);
    setStatus("Transcribing…", "active");
  }
}

// Decode compressed audio and resample to the mono 16 kHz Float32 Whisper needs.
async function blobToWhisperAudio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AudioCtx();
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  decodeCtx.close();

  // Resample to 16 kHz mono using an OfflineAudioContext.
  const duration = decoded.duration;
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(duration * WHISPER_SAMPLE_RATE),
    WHISPER_SAMPLE_RATE
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0); // Float32Array, mono, 16 kHz
}

async function transcribeBlob(blob) {
  try {
    const model = await ensureModel();
    const audio = await blobToWhisperAudio(blob);

    if (audio.length < WHISPER_SAMPLE_RATE * 0.3) {
      setStatus("That was too short to transcribe. Try again.", "error");
      setDot("ready");
      return;
    }

    const result = await model(audio);
    const text = (result.text || "").trim();

    if (text) {
      appendText(text);
      setStatus("Added. Record again to keep going.");
    } else {
      setStatus("Didn't catch anything. Try again.");
    }
    setDot("ready");
  } catch (err) {
    setDot("error");
    setStatus(`Transcription failed: ${err.message}`, "error");
  }
}

// Append transcribed text to the editor at the end, with sensible spacing.
function appendText(text) {
  const existing = els.editor.innerText.replace(/\s+$/, "");
  const needsSpace = existing.length > 0;
  const sep = needsSpace ? (/[.!?]$/.test(existing) ? " " : " ") : "";
  els.editor.innerText = existing + sep + text;
  updateWordCount();
  scheduleSave();
  // Keep the newest text in view.
  els.editor.scrollTop = els.editor.scrollHeight;
}

// ---------------------------------------------------------------------------
// Export & New
// ---------------------------------------------------------------------------
function exportTxt() {
  const text = els.editor.innerText;
  if (!text.trim()) {
    setStatus("Nothing to export yet.");
    return;
  }
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `voice-note-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function newNote() {
  if (els.editor.innerText.trim() && !confirm("Clear the current note? This can't be undone.")) {
    return;
  }
  els.editor.innerText = "";
  localStorage.removeItem(STORAGE_KEY);
  updateWordCount();
  setStatus("Started a new note.");
  els.editor.focus();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
els.recordBtn.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

els.editor.addEventListener("input", () => {
  updateWordCount();
  scheduleSave();
});

els.exportBtn.addEventListener("click", exportTxt);
els.newBtn.addEventListener("click", newNote);

els.modelSelect.addEventListener("change", () => {
  transcriber = null; // force reload on next use
  setDot("");
  setStatus(`Model set to ${els.modelSelect.value.split("/")[1]}. It loads on next recording.`);
});

// Restore saved model choice and document on startup.
if ([...els.modelSelect.options].some((o) => o.value === currentModel)) {
  els.modelSelect.value = currentModel;
}
loadDocument();
setStatus("Ready. Click Record to start (model downloads once on first use).");

// Register the service worker for offline support.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
