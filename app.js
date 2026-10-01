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
  micSelect: document.getElementById("micSelect"),
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
  searchInput: document.getElementById("searchInput"),
  liveToggle: document.getElementById("liveToggle"),
  syncBar: document.getElementById("syncBar"),
  syncDot: document.getElementById("syncDot"),
  syncText: document.getElementById("syncText"),
  connectFolderBtn: document.getElementById("connectFolderBtn"),
  disconnectFolderBtn: document.getElementById("disconnectFolderBtn"),
  readToggleRow: document.getElementById("readToggleRow"),
  readToggle: document.getElementById("readToggle"),
};

// ---- App state ----
let transcriber = null;      // the loaded Whisper pipeline
let loadingModel = false;
let currentModel = localStorage.getItem(MODEL_KEY) || els.modelSelect.value;

// Selected microphone (empty string = system/browser default).
const MIC_KEY = "voice-notes:mic";
let selectedMicId = localStorage.getItem(MIC_KEY) || "";

let mediaRecorder = null;
let audioChunks = [];
let recording = false;
let saveTimer = null;

// Live (chunked near-real-time) transcription config/state.
const LIVE_KEY = "voice-notes:live";
const LIVE_INTERVAL_MS = 3000;        // how often to re-transcribe the session
const LIVE_MAX_SESSION_SEC = 90;      // cap a single live session's audio length
let liveMode = localStorage.getItem(LIVE_KEY) === "1";
let liveTimer = null;                 // interval that triggers re-transcription
let liveInFlight = false;             // single-flight guard: one inference at a time
let liveStream = null;                // active mic stream in live mode
let committedText = "";               // editor text that existed before this session
let interimText = "";                 // latest transcription of the current session

// Notes state
let notesIndex = [];   // [{ id, title, updatedAt }]
let activeId = null;   // id of the open note
let searchQuery = "";  // current filter text (lowercased)
let dragId = null;     // id of the note being dragged

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
      // Keep the user's manual order; editing no longer reorders the list.
      saveIndex();
    }
    els.saveState.textContent = "Saved";
    els.saveState.className = "save-state saved";
    renderNotesList();
    // Mirror to the connected folder (no-op if none).
    syncNote(activeId);
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

// Does a note match the current search query (title or body)?
function noteMatches(note) {
  if (!searchQuery) return true;
  const hay = (note.title + " " + getNoteBody(note.id)).toLowerCase();
  return hay.includes(searchQuery);
}

function renderNotesList() {
  els.notesList.innerHTML = "";

  if (notesIndex.length === 0) {
    const empty = document.createElement("li");
    empty.className = "notes-empty";
    empty.textContent = "No notes yet.";
    els.notesList.appendChild(empty);
    return;
  }

  const visible = notesIndex.filter(noteMatches);
  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "notes-empty";
    empty.textContent = "No notes match your search.";
    els.notesList.appendChild(empty);
    return;
  }

  // Dragging is only enabled with no active search, so the reorder maps
  // directly onto the full list without ambiguity.
  const dragEnabled = !searchQuery;

  for (const note of visible) {
    const li = document.createElement("li");
    li.className = "note-item" + (note.id === activeId ? " active" : "");
    li.dataset.id = note.id;

    if (dragEnabled) {
      const handle = document.createElement("div");
      handle.className = "drag-handle";
      handle.title = "Drag to reorder";
      handle.textContent = "⠿";
      // Only start a drag when the handle is the grab point.
      handle.draggable = true;
      attachDragHandlers(handle, li, note.id);
      li.appendChild(handle);
    }

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

    // Conflict badge + resolution actions when a note changed in the folder.
    if (conflicts[note.id]) {
      li.classList.add("conflicted");

      const badge = document.createElement("div");
      badge.className = "note-conflict";
      badge.textContent = "⚠ Changed in folder";

      const actions = document.createElement("div");
      actions.className = "conflict-actions";

      const keep = document.createElement("button");
      keep.textContent = "Keep mine";
      keep.title = "Overwrite the folder file with the app's version (backs up the folder copy)";
      keep.addEventListener("click", (e) => {
        e.stopPropagation();
        resolveKeepMine(note.id);
      });

      const load = document.createElement("button");
      load.textContent = "Load from folder";
      load.title = "Replace the app's version with the folder file";
      load.addEventListener("click", (e) => {
        e.stopPropagation();
        resolveLoadFromDrive(note.id);
      });

      actions.append(keep, load);
      main.append(badge, actions);
    }

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

    // Make the row a drop target even though only the handle initiates dragging.
    if (dragEnabled) attachDropHandlers(li, note.id);

    els.notesList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Drag-to-reorder
// ---------------------------------------------------------------------------
function attachDragHandlers(handle, li, id) {
  handle.addEventListener("dragstart", (e) => {
    dragId = id;
    li.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Firefox requires data to be set for the drag to start.
      e.dataTransfer.setData("text/plain", id);
    }
  });
  handle.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    dragId = null;
    [...els.notesList.children].forEach((c) =>
      c.classList && c.classList.remove("drag-over")
    );
  });
}

function attachDropHandlers(li, targetId) {
  li.addEventListener("dragover", (e) => {
    if (dragId === null || dragId === targetId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    li.classList.add("drag-over");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.classList.remove("drag-over");
    if (dragId !== null && dragId !== targetId) {
      reorderNotes(dragId, targetId);
    }
  });
}

// Move the dragged note so it sits immediately before the target note.
function reorderNotes(fromId, toId) {
  const fromIdx = notesIndex.findIndex((n) => n.id === fromId);
  const toIdx = notesIndex.findIndex((n) => n.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;

  const [moved] = notesIndex.splice(fromIdx, 1);
  // Recompute target index after removal.
  const insertAt = notesIndex.findIndex((n) => n.id === toId);
  notesIndex.splice(insertAt, 0, moved);
  saveIndex();
  renderNotesList();
}

function onDeleteNote(id) {
  const entry = indexEntry(id);
  const label = entry && entry.title ? `"${entry.title}"` : "this note";
  if (!confirm(`Delete ${label}? This can't be undone.`)) return;

  const wasActive = id === activeId;
  const entrySnapshot = entry ? { ...entry } : null;
  deleteNote(id);
  delete conflicts[id];
  if (entrySnapshot) deleteNoteFile(entrySnapshot);

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
// Microphone selection
// ---------------------------------------------------------------------------
// Open a stream for the chosen mic. If a specific device was picked but is no
// longer available, fall back to the default rather than failing.
async function getMicStream() {
  if (selectedMicId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedMicId } },
      });
    } catch (err) {
      // Device gone or not usable — clear it and fall back to default.
      if (err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
        setStatus("Chosen microphone unavailable; using the default.", "error");
        selectedMicId = "";
        localStorage.removeItem(MIC_KEY);
        populateMicList();
      } else {
        throw err;
      }
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

// Populate the mic dropdown from available input devices. Device labels are only
// exposed after mic permission has been granted at least once; before that they
// show as generic names.
async function populateMicList() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const mics = devices.filter((d) => d.kind === "audioinput");

  // Rebuild options: always a "Default" entry, then each detected mic.
  els.micSelect.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Default microphone";
  els.micSelect.appendChild(def);

  let i = 1;
  let selectedStillPresent = false;
  for (const d of mics) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${i}`;
    if (d.deviceId === selectedMicId) selectedStillPresent = true;
    els.micSelect.appendChild(opt);
    i++;
  }

  // If a previously-saved device is gone, revert the selection to default.
  if (selectedMicId && !selectedStillPresent) {
    selectedMicId = "";
    localStorage.removeItem(MIC_KEY);
  }
  els.micSelect.value = selectedMicId;
}

// ---------------------------------------------------------------------------
// Audio: record -> decode -> resample to 16kHz mono Float32 -> transcribe
// ---------------------------------------------------------------------------
async function startRecording() {
  let stream;
  try {
    stream = await getMicStream();
  } catch (err) {
    setStatus(`Microphone access denied: ${err.message}`, "error");
    return;
  }

  // First successful grant reveals device labels — refresh the picker.
  populateMicList();

  // Warm up the model while the user starts talking.
  ensureModel().catch(() => {});

  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  liveStream = stream;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  if (liveMode) {
    startLiveRecording(stream);
  } else {
    startStopRecording(stream);
  }

  recording = true;
  setRecordingUI(true);
}

// --- Mode 1: record then transcribe once on Stop (original behavior) ---
function startStopRecording(stream) {
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    await transcribeBlob(blob);
  };
  mediaRecorder.start();
  setStatus("Recording… click Stop when you're done.", "active");
}

// --- Mode 2: live chunked near-real-time transcription ---
function startLiveRecording(stream) {
  // Snapshot the text already in the editor; the session's interim text is
  // appended after it and refreshed on each pass.
  committedText = els.editor.innerText.replace(/\s+$/, "");
  interimText = "";

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(liveTimer);
    liveTimer = null;
    // One final pass to catch the tail, then commit the result permanently.
    await runLivePass(true);
    setDot("ready");
  };

  // Emit data periodically so audioChunks fills during the session.
  mediaRecorder.start(1000);
  setStatus("Live… transcribing as you speak. Click Stop to finish.", "active");

  liveTimer = setInterval(() => {
    runLivePass(false);
  }, LIVE_INTERVAL_MS);
}

// Transcribe the whole current session's audio and update the editor's interim
// portion. Transcribing the full session (not just the newest slice) keeps
// Whisper seeing complete audio so words aren't clipped at chunk boundaries.
async function runLivePass(isFinal) {
  // Single-flight: if a pass is still running, skip this tick (graceful on slow HW).
  if (liveInFlight) return;
  if (audioChunks.length === 0) return;

  liveInFlight = true;
  if (!isFinal) setDot("loading");

  try {
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    const model = await ensureModel();
    const audio = await blobToWhisperAudio(blob);

    // Cap how much audio we feed in so very long sessions stay responsive.
    const maxSamples = WHISPER_SAMPLE_RATE * LIVE_MAX_SESSION_SEC;
    const clip = audio.length > maxSamples ? audio.slice(-maxSamples) : audio;

    if (clip.length >= WHISPER_SAMPLE_RATE * 0.3) {
      const result = await model(clip);
      interimText = (result.text || "").trim();
      renderLiveText();
    }
  } catch (err) {
    setStatus(`Live transcription error: ${err.message}`, "error");
  } finally {
    liveInFlight = false;
  }

  if (isFinal) {
    commitLiveText();
  }
}

// Show committed + interim text together while a live session is active.
function renderLiveText() {
  const sep = committedText && interimText ? " " : "";
  els.editor.innerText = committedText + sep + interimText;
  updateWordCount();
  els.editor.scrollTop = els.editor.scrollHeight;
}

// Fold the interim text into the committed text and persist.
function commitLiveText() {
  const sep = committedText && interimText ? " " : "";
  committedText = (committedText + sep + interimText).replace(/\s+$/, "");
  interimText = "";
  els.editor.innerText = committedText;
  updateWordCount();
  scheduleSave();
  setStatus("Live transcription saved.");
}

function stopRecording() {
  if (mediaRecorder && recording) {
    mediaRecorder.stop();
    recording = false;
    setRecordingUI(false);
    setStatus(liveMode ? "Finishing up…" : "Transcribing…", "active");
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

// ===========================================================================
// Folder sync (File System Access API) — optional, one-way by default.
//
// Design:
//  - localStorage remains the source of truth. The chosen folder is a MIRROR.
//  - App -> file: each note is written to "<slug>__<id>.txt" in the folder.
//  - Before overwriting a file, we check whether it changed externally since we
//    last wrote it (compare lastModified + size, stored per note in the index).
//    If it did, we DO NOT overwrite — we mark the note "Changed in Drive" and let
//    the user resolve it (Keep mine / Load from Drive).
//  - "Keep mine" first copies the current file to "<name>.bak-<timestamp>.txt" so
//    the external version is never lost, then writes our version.
//  - "Read external edits" (opt-in) also scans files on connect/periodically and
//    surfaces the same conflict badge so external edits can be pulled in on demand.
// ===========================================================================
const FS_DB = "voice-notes-fs";
const FS_STORE = "handles";
const FS_HANDLE_KEY = "dirHandle";
const READ_KEY = "voice-notes:readExternal";

const fsSupported = typeof window !== "undefined" && "showDirectoryPicker" in window;
let dirHandle = null;                 // FileSystemDirectoryHandle for the synced folder
let readExternal = localStorage.getItem(READ_KEY) === "1";
let conflicts = {};                   // id -> true when a note is in conflict
let scanTimer = null;

// --- tiny IndexedDB wrapper just for persisting the directory handle ---
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FS_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FS_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, "readwrite");
    tx.objectStore(FS_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, "readonly");
    const r = tx.objectStore(FS_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, "readwrite");
    tx.objectStore(FS_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- status UI ---
function setSync(kind, text) {
  els.syncDot.className = "sync-dot" + (kind ? " " + kind : "");
  els.syncText.textContent = text;
}

function reflectSyncUI() {
  const connected = !!dirHandle;
  els.connectFolderBtn.hidden = connected;
  els.disconnectFolderBtn.hidden = !connected;
  els.readToggleRow.hidden = !connected;
  els.readToggle.checked = readExternal;
  if (!fsSupported) {
    setSync("", "Folder sync not supported in this browser");
    els.connectFolderBtn.disabled = true;
  } else if (!connected) {
    setSync("", "Folder sync off");
  } else {
    setSync("connected", "Synced to folder");
  }
}

// --- filename for a note: readable slug + stable id suffix ---
function noteFileName(entry) {
  const base = slugify(entry.title) || "note";
  return `${base}__${entry.id}.txt`;
}

// --- permission handling ---
async function ensurePermission(handle, mode = "readwrite") {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

// --- connect / disconnect ---
async function connectFolder() {
  if (!fsSupported) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    dirHandle = handle;
    await idbSet(FS_HANDLE_KEY, handle);
    reflectSyncUI();
    setSync("syncing", "Writing notes to folder…");
    await syncAllNotes();
    setSync("connected", "Synced to folder");
    setStatus("Folder connected. Notes will be saved there as .txt files.");
  } catch (err) {
    if (err && err.name === "AbortError") return; // user cancelled picker
    setSync("error", "Connect failed");
    setStatus(`Could not connect folder: ${err.message}`, "error");
  }
}

async function disconnectFolder() {
  dirHandle = null;
  conflicts = {};
  await idbDel(FS_HANDLE_KEY);
  clearInterval(scanTimer);
  scanTimer = null;
  reflectSyncUI();
  renderNotesList();
  setStatus("Folder disconnected. Notes stay saved in the app.");
}

// On startup, try to restore a previously-connected folder handle.
async function restoreFolder() {
  if (!fsSupported) {
    reflectSyncUI();
    return;
  }
  try {
    const handle = await idbGet(FS_HANDLE_KEY);
    if (handle) {
      // We have a handle but must re-verify permission (often needs a click).
      if (await ensurePermission(handle, "readwrite")) {
        dirHandle = handle;
        reflectSyncUI();
        startScanLoop();
        return;
      }
    }
  } catch {
    /* ignore */
  }
  reflectSyncUI();
}

// --- read a note's file, returning { text, lastModified, size } or null ---
// The file we last wrote for this note (survives title/slug changes). Falls back
// to the computed name for notes written before filename tracking existed.
function syncedFileName(entry) {
  return (entry.sync && entry.sync.fileName) || noteFileName(entry);
}

async function readNoteFile(entry) {
  if (!dirHandle) return null;
  try {
    const fh = await dirHandle.getFileHandle(syncedFileName(entry));
    const file = await fh.getFile();
    const text = await file.text();
    return { text, lastModified: file.lastModified, size: file.size };
  } catch (err) {
    if (err && err.name === "NotFoundError") return null;
    throw err;
  }
}

// Has the file changed externally since we last wrote it?
async function isExternallyChanged(entry) {
  if (!entry.sync) return false; // we've never written it, nothing to clobber
  const info = await readNoteFile(entry);
  if (!info) return false; // file missing; treat as not-a-conflict (we'll recreate)
  return info.lastModified !== entry.sync.lastModified || info.size !== entry.sync.size;
}

// Write one note's body to its file, recording the resulting file stamp.
async function writeNoteFile(entry, body) {
  const newName = noteFileName(entry);
  const oldName = entry.sync && entry.sync.fileName;

  const fh = await dirHandle.getFileHandle(newName, { create: true });
  const w = await fh.createWritable();
  await w.write(body);
  await w.close();
  const file = await fh.getFile();
  entry.sync = { lastModified: file.lastModified, size: file.size, fileName: newName };
  saveIndex();

  // If the note was renamed, the filename changed (the stable id suffix stays).
  // Remove the orphaned old file now that the new one is written successfully.
  if (oldName && oldName !== newName) {
    try {
      await dirHandle.removeEntry(oldName);
    } catch {
      /* old file may already be gone; ignore */
    }
  }
}

// Sync a single note (called from scheduleSave). Guards against clobbering.
async function syncNote(id) {
  if (!dirHandle) return;
  const entry = indexEntry(id);
  if (!entry) return;
  try {
    if (await isExternallyChanged(entry)) {
      conflicts[id] = true;
      setSync("error", "A note changed in the folder");
      renderNotesList();
      return;
    }
    setSync("syncing", "Saving to folder…");
    await writeNoteFile(entry, getNoteBody(id));
    setSync("connected", "Synced to folder");
  } catch (err) {
    setSync("error", "Sync error");
    setStatus(`Folder sync error: ${err.message}`, "error");
  }
}

// Write every note out (used on first connect).
async function syncAllNotes() {
  if (!dirHandle) return;
  for (const entry of notesIndex) {
    try {
      // Don't clobber external changes during a bulk sync either.
      if (await isExternallyChanged(entry)) {
        conflicts[entry.id] = true;
        continue;
      }
      await writeNoteFile(entry, getNoteBody(entry.id));
    } catch {
      /* skip this file, continue */
    }
  }
  renderNotesList();
}

// Remove a note's file when the note is deleted in-app.
async function deleteNoteFile(entry) {
  if (!dirHandle || !entry) return;
  try {
    await dirHandle.removeEntry(syncedFileName(entry));
  } catch {
    /* file may not exist; ignore */
  }
}

// --- conflict resolution ---
async function resolveKeepMine(id) {
  const entry = indexEntry(id);
  if (!entry || !dirHandle) return;
  try {
    // Back up the external version first so it's never lost.
    const info = await readNoteFile(entry);
    if (info) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const bakName = noteFileName(entry).replace(/\.txt$/, `.bak-${stamp}.txt`);
      const bh = await dirHandle.getFileHandle(bakName, { create: true });
      const bw = await bh.createWritable();
      await bw.write(info.text);
      await bw.close();
    }
    await writeNoteFile(entry, getNoteBody(id));
    delete conflicts[id];
    setSync("connected", "Synced to folder");
    setStatus("Kept your version. The folder copy was backed up as a .bak file.");
    renderNotesList();
  } catch (err) {
    setStatus(`Could not resolve: ${err.message}`, "error");
  }
}

async function resolveLoadFromDrive(id) {
  const entry = indexEntry(id);
  if (!entry || !dirHandle) return;
  try {
    const info = await readNoteFile(entry);
    if (!info) {
      delete conflicts[id];
      renderNotesList();
      return;
    }
    setNoteBody(id, info.text);
    entry.title = els.noteTitle.value.trim() || deriveTitle(info.text) || entry.title;
    entry.sync = { lastModified: info.lastModified, size: info.size };
    saveIndex();
    delete conflicts[id];
    if (id === activeId) {
      els.editor.innerText = info.text;
      updateWordCount();
    }
    setSync("connected", "Synced to folder");
    setStatus("Loaded the folder version into the app.");
    renderNotesList();
  } catch (err) {
    setStatus(`Could not load from folder: ${err.message}`, "error");
  }
}

// --- optional read-direction scan: flag notes whose files changed externally ---
async function scanForExternalChanges() {
  if (!dirHandle || !readExternal) return;
  let found = false;
  for (const entry of notesIndex) {
    try {
      if (await isExternallyChanged(entry)) {
        conflicts[entry.id] = true;
        found = true;
      }
    } catch {
      /* ignore */
    }
  }
  if (found) {
    setSync("error", "A note changed in the folder");
    renderNotesList();
  }
}

function startScanLoop() {
  clearInterval(scanTimer);
  if (dirHandle && readExternal) {
    scanForExternalChanges();
    scanTimer = setInterval(scanForExternalChanges, 15000);
  }
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

// Search filter.
els.searchInput.addEventListener("input", () => {
  searchQuery = els.searchInput.value.trim().toLowerCase();
  renderNotesList();
});

// Folder sync controls.
els.connectFolderBtn.addEventListener("click", connectFolder);
els.disconnectFolderBtn.addEventListener("click", disconnectFolder);
els.readToggle.addEventListener("change", () => {
  readExternal = els.readToggle.checked;
  localStorage.setItem(READ_KEY, readExternal ? "1" : "0");
  if (readExternal) {
    setStatus("Will watch for edits made to the files outside the app.");
    startScanLoop();
  } else {
    clearInterval(scanTimer);
    scanTimer = null;
    setStatus("No longer watching for external edits.");
  }
});

// Live transcription toggle.
els.liveToggle.addEventListener("change", () => {
  liveMode = els.liveToggle.checked;
  localStorage.setItem(LIVE_KEY, liveMode ? "1" : "0");
  setStatus(
    liveMode
      ? "Live mode on. Text appears as you speak (tiny.en recommended for speed)."
      : "Live mode off. Transcribes once when you click Stop."
  );
});

// Sidebar toggles.
els.sidebarToggle.addEventListener("click", toggleSidebar);
els.sidebarBackdrop.addEventListener("click", closeSidebar);

els.modelSelect.addEventListener("change", () => {
  transcriber = null; // force reload on next use
  setDot("");
  setStatus(`Model set to ${els.modelSelect.value.split("/")[1]}. It loads on next recording.`);
});

// Microphone selection.
els.micSelect.addEventListener("change", () => {
  selectedMicId = els.micSelect.value;
  if (selectedMicId) localStorage.setItem(MIC_KEY, selectedMicId);
  else localStorage.removeItem(MIC_KEY);
  const label = els.micSelect.options[els.micSelect.selectedIndex].textContent;
  setStatus(`Microphone set to: ${label}`);
});

// Refresh the mic list when devices are plugged/unplugged.
if (navigator.mediaDevices && "ondevicechange" in navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener("devicechange", populateMicList);
}

// Restore saved model choice.
if ([...els.modelSelect.options].some((o) => o.value === currentModel)) {
  els.modelSelect.value = currentModel;
}

// Restore live-mode toggle state.
els.liveToggle.checked = liveMode;

// Populate the microphone list (labels appear after first permission grant).
populateMicList();

// Set up folder sync UI and try to restore a previously-connected folder.
reflectSyncUI();
restoreFolder();

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

// ---------------------------------------------------------------------------
// Keyboard shortcuts
//   Ctrl/Cmd + N  new note
//   Ctrl/Cmd + F  focus search
//   Ctrl/Cmd + S  export current note
//   Ctrl/Cmd + B  toggle sidebar
//   Space         start/stop recording (only when not typing in a field)
// ---------------------------------------------------------------------------
function isTypingTarget(el) {
  if (!el) return false;
  if (el === els.editor) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;

  if (mod && !e.shiftKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === "n") {
      e.preventDefault();
      onNewNote();
      return;
    }
    if (key === "f") {
      e.preventDefault();
      if (els.sidebar.classList.contains("collapsed")) openSidebar();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (key === "s") {
      e.preventDefault();
      exportTxt();
      return;
    }
    if (key === "b") {
      e.preventDefault();
      toggleSidebar();
      return;
    }
  }

  // Space toggles recording, but only when the user isn't typing somewhere.
  if ((e.key === " " || e.code === "Space") && !isTypingTarget(e.target)) {
    e.preventDefault();
    if (recording) stopRecording();
    else startRecording();
  }
});

// Register the service worker for offline support.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
