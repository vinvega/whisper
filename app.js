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

// Storage layout:
//   voice-notes:index    -> JSON array of { id, title, updatedAt }
//   voice-notes:note:ID  -> the note body (plain text)
//   voice-notes:active   -> id of the currently open note
//   voice-notes:model    -> selected model id
//   voice-notes:document -> (legacy) single-document body, migrated on load
const INDEX_KEY = "voice-notes:index";
const NOTE_PREFIX = "voice-notes:note:";
const ACTIVE_KEY = "voice-notes:active";
const MODEL_KEY = "voice-notes:model";
const LEGACY_KEY = "voice-notes:document";

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
  sidebar: document.getElementById("sidebar"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  notesList: document.getElementById("notesList"),
  newNoteBtn: document.getElementById("newNoteBtn"),
  noteTitle: document.getElementById("noteTitle"),
};

// ---- App state ----
let transcriber = null;      // the loaded Whisper pipeline
let loadingModel = false;
let currentModel = localStorage.getItem(MODEL_KEY) || els.modelSelect.value;

let mediaRecorder = null;
let audioChunks = [];
let recording = false;
let saveTimer = null;

// Notes state
let notesIndex = [];   // [{ id, title, updatedAt }]
let activeId = null;   // id of the open note

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
// Notes model (localStorage)
// ---------------------------------------------------------------------------
function newId() {
  return "n_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function loadIndex() {
  try {
    notesIndex = JSON.parse(localStorage.getItem(INDEX_KEY)) || [];
  } catch {
    notesIndex = [];
  }
}

function saveIndex() {
  localStorage.setItem(INDEX_KEY, JSON.stringify(notesIndex));
}

function getNoteBody(id) {
  return localStorage.getItem(NOTE_PREFIX + id) || "";
}

function setNoteBody(id, body) {
  localStorage.setItem(NOTE_PREFIX + id, body);
}

// Derive a title from the first non-empty line of the body.
function deriveTitle(body) {
  const firstLine = (body || "").split("\n").map((l) => l.trim()).find(Boolean);
  if (!firstLine) return "Untitled note";
  return firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
}

function indexEntry(id) {
  return notesIndex.find((n) => n.id === id);
}

function createNote(initialBody = "") {
  const id = newId();
  setNoteBody(id, initialBody);
  notesIndex.unshift({ id, title: deriveTitle(initialBody), updatedAt: Date.now() });
  saveIndex();
  return id;
}

function deleteNote(id) {
  localStorage.removeItem(NOTE_PREFIX + id);
  notesIndex = notesIndex.filter((n) => n.id !== id);
  saveIndex();
}

// Migrate the old single-document storage into the first note (one-time).
function migrateLegacy() {
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy !== null) {
    const id = createNote(legacy);
    localStorage.removeItem(LEGACY_KEY);
    return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Active note + persistence (debounced)
// ---------------------------------------------------------------------------
function openNote(id) {
  const entry = indexEntry(id);
  if (!entry) return;
  activeId = id;
  localStorage.setItem(ACTIVE_KEY, id);
  els.editor.innerText = getNoteBody(id);
  els.noteTitle.value = entry.title === "Untitled note" ? "" : entry.title;
  updateWordCount();
  els.saveState.textContent = "Saved";
  els.saveState.className = "save-state saved";
  renderNotesList();
}

function markSaving() {
  els.saveState.textContent = "Saving…";
  els.saveState.className = "save-state saving";
}

// Persist the active note body and refresh its index entry.
function scheduleSave() {
  if (!activeId) return;
  markSaving();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = els.editor.innerText;
    setNoteBody(activeId, body);
    const entry = indexEntry(activeId);
    if (entry) {
      // If the user hasn't set a custom title, keep it derived from the body.
      const custom = els.noteTitle.value.trim();
      entry.title = custom || deriveTitle(body);
      entry.updatedAt = Date.now();
      // Move most-recently-edited note to the top.
      notesIndex = [entry, ...notesIndex.filter((n) => n.id !== activeId)];
      saveIndex();
    }
    els.saveState.textContent = "Saved";
    els.saveState.className = "save-state saved";
    renderNotesList();
  }, 400);
}

// ---------------------------------------------------------------------------
// Sidebar rendering & interaction
// ---------------------------------------------------------------------------
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderNotesList() {
  els.notesList.innerHTML = "";
  if (notesIndex.length === 0) {
    const empty = document.createElement("li");
    empty.className = "note-item-preview";
    empty.style.padding = "10px";
    empty.textContent = "No notes yet.";
    els.notesList.appendChild(empty);
    return;
  }

  for (const note of notesIndex) {
    const li = document.createElement("li");
    li.className = "note-item" + (note.id === activeId ? " active" : "");
    li.dataset.id = note.id;

    const main = document.createElement("div");
    main.className = "note-item-main";

    const title = document.createElement("div");
    title.className = "note-item-title";
    title.textContent = note.title || "Untitled note";

    const preview = document.createElement("div");
    preview.className = "note-item-preview";
    const body = getNoteBody(note.id).replace(/\s+/g, " ").trim();
    preview.textContent = body.slice(0, 80) || "Empty";

    const time = document.createElement("div");
    time.className = "note-item-time";
    time.textContent = formatTime(note.updatedAt);

    main.append(title, preview, time);

    const del = document.createElement("button");
    del.className = "note-delete";
    del.title = "Delete note";
    del.setAttribute("aria-label", "Delete note");
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      onDeleteNote(note.id);
    });

    li.append(main, del);
    li.addEventListener("click", () => {
      if (note.id !== activeId) openNote(note.id);
      if (isOverlayMode()) closeSidebar();
    });

    els.notesList.appendChild(li);
  }
}

function onDeleteNote(id) {
  const entry = indexEntry(id);
  const label = entry && entry.title ? `"${entry.title}"` : "this note";
  if (!confirm(`Delete ${label}? This can't be undone.`)) return;

  const wasActive = id === activeId;
  deleteNote(id);

  if (wasActive) {
    if (notesIndex.length === 0) {
      activeId = createNote("");
    }
    openNote(notesIndex[0].id);
  } else {
    renderNotesList();
  }
  setStatus("Note deleted.");
}

function onNewNote() {
  const id = createNote("");
  openNote(id);
  els.noteTitle.focus();
  if (isOverlayMode()) closeSidebar();
  setStatus("New note created.");
}

// ---------------------------------------------------------------------------
// Sidebar visibility
// ---------------------------------------------------------------------------
function isOverlayMode() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function openSidebar() {
  els.sidebar.classList.remove("collapsed");
  if (isOverlayMode()) els.sidebarBackdrop.hidden = false;
}

function closeSidebar() {
  els.sidebar.classList.add("collapsed");
  els.sidebarBackdrop.hidden = true;
}

function toggleSidebar() {
  if (els.sidebar.classList.contains("collapsed")) openSidebar();
  else closeSidebar();
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
// Export (current note)
// ---------------------------------------------------------------------------
function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function exportTxt() {
  const text = els.editor.innerText;
  if (!text.trim()) {
    setStatus("Nothing to export yet.");
    return;
  }
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const entry = indexEntry(activeId);
  const base = slugify(entry && entry.title) || "voice-note";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `${base}-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
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
els.newBtn.addEventListener("click", onNewNote);
els.newNoteBtn.addEventListener("click", onNewNote);

// Title edits save to the active note's index entry.
els.noteTitle.addEventListener("input", scheduleSave);
els.noteTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    els.editor.focus();
  }
});

// Sidebar toggles.
els.sidebarToggle.addEventListener("click", toggleSidebar);
els.sidebarBackdrop.addEventListener("click", closeSidebar);

els.modelSelect.addEventListener("change", () => {
  transcriber = null; // force reload on next use
  setDot("");
  setStatus(`Model set to ${els.modelSelect.value.split("/")[1]}. It loads on next recording.`);
});

// Restore saved model choice.
if ([...els.modelSelect.options].some((o) => o.value === currentModel)) {
  els.modelSelect.value = currentModel;
}

// --- Startup: load notes, migrate legacy, open an active note ---
loadIndex();
migrateLegacy();
if (notesIndex.length === 0) {
  createNote("");
}
const savedActive = localStorage.getItem(ACTIVE_KEY);
const startId = indexEntry(savedActive) ? savedActive : notesIndex[0].id;
openNote(startId);

// On mobile, start with the sidebar collapsed so the editor is front and center.
if (isOverlayMode()) closeSidebar();

setStatus("Ready. Click Record to start (model downloads once on first use).");

// Register the service worker for offline support.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
