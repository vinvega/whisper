// Collaborative story — UI controller (browser-only).
//
// Self-contained module loaded AFTER app.js. It drives the collaboration view
// (mode toggle, folder connect, post list, post editor, media, assembly) by
// reusing the pure logic in collab-core.js and the storage layer in
// collab-store.js. It never touches the private-notes code; it only reads two
// bridges that app.js exposes on window:
//   - window.__transcriptSink   : set to receive dictated transcripts
//   - window.__voiceCapture      : { start, stop, isRecording }
//
// Robustness contract: this module must be harmless if the collab DOM is absent
// (e.g. the HTML wasn't added). Every entry point guards on element existence,
// and all File System Access calls are wrapped in try/catch with errors surfaced
// to #collabStatus rather than thrown.

import {
  PEN_NAME_KEY,
  penSlug,
  newPostId,
  nextOrder,
  sortPosts,
} from "./collab-core.js";
import { createCollabStore } from "./collab-store.js";
import { renderMarkdown } from "./md-render.js";

// ---------------------------------------------------------------------------
// Element lookup + guard. If the core collab DOM is missing, bail quietly.
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const els = {
  modeToggle: $("modeToggle"),
  // private-notes surfaces we show/hide
  appMain: document.querySelector(".app-main"),
  notesSidebar: $("sidebar"),
  liveToggle: $("liveToggle"),
  // collab surfaces
  collabMain: $("collabMain"),
  collabSidebar: $("collabSidebar"),
  penNameInput: $("penNameInput"),
  connectStoryBtn: $("connectStoryBtn"),
  disconnectStoryBtn: $("disconnectStoryBtn"),
  refreshStoryBtn: $("refreshStoryBtn"),
  updatesIndicator: $("updatesIndicator"),
  collabStatus: $("collabStatus"),
  postList: $("postList"),
  newPostBtn: $("newPostBtn"),
  postEditor: $("postEditor"),
  postRecordBtn: $("postRecordBtn"),
  insertPictureBtn: $("insertPictureBtn"),
  savePostBtn: $("savePostBtn"),
  deletePostBtn: $("deletePostBtn"),
  postSaveState: $("postSaveState"),
  autoSaveToggle: $("autoSaveToggle"),
  assembledView: $("assembledView"),
  buildStoryBtn: $("buildStoryBtn"),
  downloadStoryBtn: $("downloadStoryBtn"),
  // media modal
  mediaPickerModal: $("mediaPickerModal"),
  mediaUploadInput: $("mediaUploadInput"),
  mediaGrid: $("mediaGrid"),
  mediaAltInput: $("mediaAltInput"),
  mediaInsertBtn: $("mediaInsertBtn"),
  mediaCancelBtn: $("mediaCancelBtn"),
};

// If the essential collab chrome is missing, do nothing. The module is inert.
if (els.modeToggle && els.collabMain && els.collabSidebar && els.postEditor) {
  initCollab();
}

function initCollab() {
  // -------------------------------------------------------------------------
  // Module state
  // -------------------------------------------------------------------------
  const FS_DB = "voice-notes-fs";
  const FS_STORE = "handles";
  const COLLAB_HANDLE_KEY = "collabDirHandle";
  const BG_CHECK_MS = 20000;   // background "updates available" probe
  const IDLE_BUILD_MS = 30000; // idle auto-build timer

  const AUTOSAVE_KEY = "voice-notes:collabAutoSave";
  const AUTOSAVE_MS = 1200;    // debounce for auto-save while typing

  const fsSupported =
    typeof window !== "undefined" && "showDirectoryPicker" in window;

  let penName = localStorage.getItem(PEN_NAME_KEY) || "";
  let dirHandle = null;
  let store = null;
  let collabActive = false;      // is the collab view currently shown
  let editingId = null;          // id of post open in the editor (null = none)
  let editingNew = false;        // editor holds an unsaved brand-new post
  let dirty = false;             // editor has unsaved changes
  let autoSave = localStorage.getItem(AUTOSAVE_KEY) === "1";
  let autoSaveTimer = null;
  let bgTimer = null;
  let idleTimer = null;
  let savedRange = null;         // last caret Range inside #postEditor
  let mediaObjectUrls = [];      // object URLs to revoke when the modal closes
  let assembledUrls = [];        // object URLs for images in the assembled preview
  let pendingUpload = null;      // { name } freshly uploaded, pre-selected
  let dragId = null;             // id of the own-post being dragged to reorder

  // Format an ISO timestamp for display (same-day -> time, else short date).
  function formatWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) +
        " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Unsaved-state indicator.
  function setSaveState(state) {
    if (!els.postSaveState) return;
    if (state === "saved") {
      els.postSaveState.textContent = "Saved";
      els.postSaveState.className = "post-save-state saved";
    } else if (state === "saving") {
      els.postSaveState.textContent = "Saving…";
      els.postSaveState.className = "post-save-state saving";
    } else if (state === "unsaved") {
      els.postSaveState.textContent = "Unsaved changes";
      els.postSaveState.className = "post-save-state unsaved";
    } else {
      els.postSaveState.textContent = "";
      els.postSaveState.className = "post-save-state";
    }
  }

  function markDirty() {
    dirty = true;
    setSaveState("unsaved");
    if (autoSave) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        if (dirty && editingId !== null) savePost();
      }, AUTOSAVE_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Tiny IndexedDB helpers (same DB/store as app.js, independent key).
  // -------------------------------------------------------------------------
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(FS_DB, 1);
      // app.js owns the upgrade; we create the store too in case we open first.
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FS_STORE)) {
          db.createObjectStore(FS_STORE);
        }
      };
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

  // -------------------------------------------------------------------------
  // Status helpers
  // -------------------------------------------------------------------------
  function setStatus(text, kind = "") {
    if (!els.collabStatus) return;
    els.collabStatus.textContent = text;
    els.collabStatus.className = "collab-status" + (kind ? " " + kind : "");
  }

  async function ensurePermission(handle, mode = "readwrite") {
    if (!handle) return false;
    const opts = { mode };
    try {
      if ((await handle.queryPermission(opts)) === "granted") return true;
      if ((await handle.requestPermission(opts)) === "granted") return true;
    } catch {
      return false;
    }
    return false;
  }

  // =========================================================================
  // (1) Pen name
  // =========================================================================
  function loadPenName() {
    penName = localStorage.getItem(PEN_NAME_KEY) || "";
    if (els.penNameInput) els.penNameInput.value = penName;
  }
  function savePenName(value) {
    penName = (value || "").trim();
    localStorage.setItem(PEN_NAME_KEY, penName);
    // Rebuild the store with the new identity if we're connected.
    if (dirHandle && penName) {
      store = createCollabStore(dirHandle, penName);
      refreshNow().catch(() => {});
    }
    reflectConnectUI();
  }

  if (els.penNameInput) {
    els.penNameInput.addEventListener("change", () =>
      savePenName(els.penNameInput.value)
    );
    els.penNameInput.addEventListener("blur", () =>
      savePenName(els.penNameInput.value)
    );
  }

  // =========================================================================
  // (2) Mode toggle: swap private notes <-> collaboration
  // =========================================================================
  function showCollab(on) {
    collabActive = on;
    document.body.classList.toggle("collab-mode", on);
    // Private notes surfaces
    if (els.appMain) els.appMain.hidden = on;
    if (els.notesSidebar) els.notesSidebar.hidden = on;
    // Collab surfaces
    if (els.collabMain) els.collabMain.hidden = !on;
    if (els.collabSidebar) els.collabSidebar.hidden = !on;
    if (els.modeToggle) {
      els.modeToggle.setAttribute("aria-pressed", on ? "true" : "false");
      els.modeToggle.textContent = on ? "Notes" : "Collaboration";
    }

    if (on) {
      startBackgroundCheck();
      resetIdleTimer();
    } else {
      // Leaving collab: release the sink and stop background work.
      releaseSink();
      stopBackgroundCheck();
      clearIdleTimer();
    }
  }

  els.modeToggle.addEventListener("click", () => showCollab(!collabActive));

  // =========================================================================
  // (3) Connect / disconnect story folder
  // =========================================================================
  function reflectConnectUI() {
    const connected = !!dirHandle;
    if (els.connectStoryBtn) els.connectStoryBtn.hidden = connected;
    if (els.disconnectStoryBtn) els.disconnectStoryBtn.hidden = !connected;
    if (!fsSupported) {
      if (els.connectStoryBtn) els.connectStoryBtn.disabled = true;
      setStatus(
        "Folder access isn't supported in this browser. Private notes still work.",
        "error"
      );
    }
  }

  async function connectFolder() {
    if (!fsSupported) return;
    if (!penName) {
      setStatus("Enter a pen name first, then connect.", "error");
      if (els.penNameInput) els.penNameInput.focus();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      dirHandle = handle;
      await idbSet(COLLAB_HANDLE_KEY, handle);
      store = createCollabStore(dirHandle, penName);
      reflectConnectUI();
      setStatus("Connected. Loading posts…");
      await refreshNow();
      setStatus("Connected to story folder.", "ok");
      startBackgroundCheck();
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled picker
      setStatus("Could not connect: " + (err && err.message), "error");
    }
  }

  async function disconnectFolder() {
    try {
      await idbDel(COLLAB_HANDLE_KEY);
    } catch {
      /* ignore */
    }
    dirHandle = null;
    store = null;
    stopBackgroundCheck();
    hideUpdates();
    if (els.postList) els.postList.innerHTML = "";
    if (els.assembledView) els.assembledView.textContent = "";
    closeEditor();
    reflectConnectUI();
    setStatus("Disconnected. The folder itself is untouched.");
  }

  async function restoreFolder() {
    if (!fsSupported) {
      reflectConnectUI();
      return;
    }
    try {
      const handle = await idbGet(COLLAB_HANDLE_KEY);
      if (!handle) return;
      const ok = await ensurePermission(handle, "readwrite");
      if (!ok) {
        setStatus("Reconnect the story folder to grant access again.");
        return;
      }
      dirHandle = handle;
      if (penName) {
        store = createCollabStore(dirHandle, penName);
        await refreshNow();
      }
      reflectConnectUI();
      setStatus("Reconnected to story folder.", "ok");
    } catch (err) {
      setStatus("Could not restore folder: " + (err && err.message), "error");
    }
  }

  if (els.connectStoryBtn)
    els.connectStoryBtn.addEventListener("click", connectFolder);
  if (els.disconnectStoryBtn)
    els.disconnectStoryBtn.addEventListener("click", disconnectFolder);

  // =========================================================================
  // (4) Refresh model + background "updates available" check
  // =========================================================================
  async function refreshNow() {
    if (!store) return;
    try {
      await store.applyRefresh();
      hideUpdates();
      renderPostList();
      renderAssembled();
    } catch (err) {
      setStatus("Refresh failed: " + (err && err.message), "error");
    }
  }

  function showUpdates(total) {
    if (!els.updatesIndicator) return;
    els.updatesIndicator.hidden = false;
    els.updatesIndicator.textContent = `${total} update${
      total === 1 ? "" : "s"
    } — Refresh`;
  }
  function hideUpdates() {
    if (els.updatesIndicator) els.updatesIndicator.hidden = true;
  }

  function startBackgroundCheck() {
    stopBackgroundCheck();
    if (!store) return;
    bgTimer = setInterval(async () => {
      if (!store) return;
      // Never auto-refresh while the user is editing a post.
      if (editingId !== null || editingNew) return;
      try {
        const { total } = await store.detectChanges();
        if (total > 0) showUpdates(total);
        else hideUpdates();
      } catch {
        /* transient FS error — try again next tick */
      }
    }, BG_CHECK_MS);
  }
  function stopBackgroundCheck() {
    if (bgTimer) {
      clearInterval(bgTimer);
      bgTimer = null;
    }
  }

  if (els.refreshStoryBtn)
    els.refreshStoryBtn.addEventListener("click", () => {
      resetIdleTimer();
      refreshNow();
    });
  if (els.updatesIndicator)
    els.updatesIndicator.addEventListener("click", () => {
      resetIdleTimer();
      refreshNow();
    });

  // =========================================================================
  // (5) Post list render (own + others, sorted)
  // =========================================================================
  function previewOf(body) {
    const text = (body || "").replace(/\s+/g, " ").trim();
    return text.length > 80 ? text.slice(0, 80) + "…" : text || "(empty)";
  }

  function renderPostList() {
    if (!els.postList) return;
    els.postList.innerHTML = "";
    if (!store) return;

    const posts = sortPosts([...store.posts.values()]);

    if (posts.length === 0) {
      const empty = document.createElement("li");
      empty.className = "notes-empty";
      empty.textContent = store ? "No posts yet. Add one." : "";
      els.postList.appendChild(empty);
      return;
    }

    for (const post of posts) {
      const li = document.createElement("li");
      li.className = "note-item" + (post.mine ? "" : " readonly");
      if (post.id === editingId) li.classList.add("active");
      li.dataset.id = post.id;

      // Drag handle (own posts only) — reorder writes a new `order` to the file.
      if (post.mine) {
        const handle = document.createElement("div");
        handle.className = "drag-handle";
        handle.title = "Drag to reorder your post";
        handle.textContent = "⠿";
        handle.draggable = true;
        attachReorderDrag(handle, li, post.id);
        li.appendChild(handle);
      }

      const main = document.createElement("div");
      main.className = "note-item-main";

      const preview = document.createElement("div");
      preview.className = "note-item-preview";
      preview.textContent = previewOf(post.body);

      const meta = document.createElement("div");
      meta.className = "post-meta";
      const author = post.mine
        ? `<span class="post-you">You</span> · ${escapeHtml(post.author)}`
        : escapeHtml(post.author);
      const when = formatWhen(post.updated || post.created);
      meta.innerHTML = `<span class="post-author">${author}</span>` +
        (when ? `<span class="post-when">${escapeHtml(when)}</span>` : "");

      main.appendChild(preview);
      main.appendChild(meta);
      li.appendChild(main);

      if (post.mine) {
        li.addEventListener("click", (e) => {
          if (e.target.closest(".note-delete") || e.target.closest(".drag-handle")) return;
          resetIdleTimer();
          openEditor(post.id);
        });
        const del = document.createElement("button");
        del.className = "note-delete";
        del.type = "button";
        del.title = "Delete this post";
        del.textContent = "×";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deletePost(post.id);
        });
        li.appendChild(del);
        attachReorderDrop(li, post.id);
      }

      els.postList.appendChild(li);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // --- Drag-to-reorder (own posts only) ------------------------------------
  function attachReorderDrag(handle, li, id) {
    handle.addEventListener("dragstart", (e) => {
      dragId = id;
      li.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id);
      }
    });
    handle.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      dragId = null;
      [...els.postList.children].forEach(
        (c) => c.classList && c.classList.remove("drag-over")
      );
    });
  }

  function attachReorderDrop(li, targetId) {
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
      if (dragId !== null && dragId !== targetId) reorderOwnPost(dragId, targetId);
    });
  }

  // Reorder: place the dragged post just before the target in the current sorted
  // view, assign it an `order` midway between the target's neighbours, and persist
  // ONLY the dragged (own) post's file. Deterministic sort does the rest for all.
  async function reorderOwnPost(fromId, toId) {
    if (!store) return;
    const dragged = store.posts.get(fromId);
    if (!dragged || !dragged.mine) {
      setStatus("You can only reorder your own posts.", "error");
      return;
    }
    const sorted = sortPosts([...store.posts.values()]);
    const toIdx = sorted.findIndex((p) => p.id === toId);
    if (toIdx === -1) return;

    const prev = sorted[toIdx - 1];
    const target = sorted[toIdx];
    // New order = midpoint between the target's predecessor and the target.
    let newOrder;
    if (!prev) newOrder = target.order - 1000;
    else newOrder = Math.floor((prev.order + target.order) / 2);
    // Guard against collision when neighbours are adjacent integers.
    if (newOrder === target.order || (prev && newOrder === prev.order)) {
      newOrder = target.order - 1; // best-effort; tiebreak handles equal values
    }

    const now = new Date().toISOString();
    const post = { ...dragged, order: newOrder, updated: now, author: penName || dragged.author };
    try {
      const res = await store.writeOwnPost(post);
      if (res && res.ok) {
        renderPostList();
        renderAssembled();
        scheduleIdleBuild();
      } else if (res && res.conflict) {
        showConflict(post, res.fileName);
      }
    } catch (err) {
      setStatus("Reorder failed: " + (err && err.message), "error");
    }
    resetIdleTimer();
  }

  // =========================================================================
  // (6) Post editor: create / edit own posts
  // =========================================================================
  function newPost() {
    if (!store) {
      setStatus("Connect a story folder first.", "error");
      return;
    }
    if (!penName) {
      setStatus("Enter a pen name before authoring.", "error");
      if (els.penNameInput) els.penNameInput.focus();
      return;
    }
    const now = new Date().toISOString();
    const post = {
      id: newPostId(),
      author: penName,
      created: now,
      order: nextOrder(),
      updated: now,
      body: "",
    };
    editingId = post.id;
    editingNew = true;
    store.setEditing(post.id);
    // Hold the new post in the map so the list shows it immediately.
    post.mine = true;
    store.posts.set(post.id, post);
    els.postEditor.innerText = "";
    if (els.deletePostBtn) els.deletePostBtn.hidden = false;
    dirty = false;
    setSaveState("unsaved"); // a new empty post isn't on disk yet
    renderPostList();
    els.postEditor.focus();
    setStatus("New post. Write, then Save.");
    resetIdleTimer();
  }

  function openEditor(id) {
    if (!store) return;
    const post = store.posts.get(id);
    if (!post || !post.mine) return;
    editingId = id;
    editingNew = false;
    store.setEditing(id);
    els.postEditor.innerText = post.body || "";
    if (els.deletePostBtn) els.deletePostBtn.hidden = false;
    dirty = false;
    setSaveState("saved");
    renderPostList();
    els.postEditor.focus();
    setStatus("Editing your post.");
  }

  function closeEditor() {
    editingId = null;
    editingNew = false;
    dirty = false;
    clearTimeout(autoSaveTimer);
    setSaveState("");
    if (store) store.setEditing(null);
    if (els.postEditor) els.postEditor.innerText = "";
    if (els.deletePostBtn) els.deletePostBtn.hidden = true;
    releaseSink();
  }

  async function savePost() {
    if (!store || editingId === null) {
      setStatus("Nothing to save.", "error");
      return;
    }
    const existing = store.posts.get(editingId);
    if (!existing) return;
    const now = new Date().toISOString();
    const post = {
      id: existing.id,
      author: penName || existing.author,
      created: existing.created || now,
      order: existing.order != null ? existing.order : nextOrder(),
      updated: now,
      body: els.postEditor.innerText,
    };
    setSaveState("saving");
    try {
      const res = await store.writeOwnPost(post);
      if (res && res.ok) {
        editingNew = false;
        dirty = false;
        setSaveState("saved");
        setStatus("Saved.", "ok");
        renderPostList();
        renderAssembled();
        scheduleIdleBuild();
      } else if (res && res.conflict) {
        setSaveState("unsaved");
        showConflict(post, res.fileName);
      }
    } catch (err) {
      setSaveState("unsaved");
      setStatus("Save failed: " + (err && err.message), "error");
    }
    resetIdleTimer();
  }

  // Conflict resolution UI: inject Keep mine / Load from folder actions into the
  // active post's list row.
  function showConflict(post, fileName) {
    setStatus(
      "This post changed in the folder. Choose Keep mine or Load from folder.",
      "error"
    );
    const li = els.postList.querySelector(
      `.note-item[data-id="${CSS.escape(post.id)}"]`
    );
    if (!li) return;
    li.classList.add("conflicted");
    if (li.querySelector(".conflict-actions")) return;

    const wrap = document.createElement("div");
    wrap.className = "conflict-actions";

    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = "Keep mine";
    keep.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const res = await store.resolveKeepMine(post);
        if (res && res.ok) {
          setStatus("Kept your version (a backup of theirs was saved).", "ok");
          renderPostList();
          renderAssembled();
        }
      } catch (err) {
        setStatus("Keep mine failed: " + (err && err.message), "error");
      }
    });

    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "Load from folder";
    load.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const loaded = await store.loadFromFolder(post.id);
        if (loaded) {
          if (editingId === post.id) els.postEditor.innerText = loaded.body || "";
          setStatus("Loaded the folder's version.", "ok");
          renderPostList();
          renderAssembled();
        }
      } catch (err) {
        setStatus("Load failed: " + (err && err.message), "error");
      }
    });

    wrap.appendChild(keep);
    wrap.appendChild(load);
    li.appendChild(wrap);
  }

  async function deletePost(id) {
    if (!store) return;
    const post = store.posts.get(id);
    if (!post || !post.mine) return;
    try {
      // A brand-new unsaved post has no file yet; just drop it locally.
      if (editingNew && editingId === id) {
        store.posts.delete(id);
      } else {
        await store.deleteOwnPost(id);
      }
      if (editingId === id) closeEditor();
      setStatus("Post deleted.");
      renderPostList();
      renderAssembled();
      scheduleIdleBuild();
    } catch (err) {
      setStatus("Delete failed: " + (err && err.message), "error");
    }
    resetIdleTimer();
  }

  if (els.newPostBtn) els.newPostBtn.addEventListener("click", newPost);
  if (els.savePostBtn) els.savePostBtn.addEventListener("click", savePost);
  if (els.deletePostBtn)
    els.deletePostBtn.addEventListener("click", () => {
      if (editingId !== null) deletePost(editingId);
    });

  // Reset idle timer + keep live body in the map as the user types.
  els.postEditor.addEventListener("input", () => {
    if (store && editingId !== null) {
      const p = store.posts.get(editingId);
      if (p) p.body = els.postEditor.innerText;
      markDirty();
    }
    resetIdleTimer();
  });

  // Auto-save toggle.
  if (els.autoSaveToggle) {
    els.autoSaveToggle.checked = autoSave;
    els.autoSaveToggle.addEventListener("change", () => {
      autoSave = els.autoSaveToggle.checked;
      localStorage.setItem(AUTOSAVE_KEY, autoSave ? "1" : "0");
      if (autoSave && dirty && editingId !== null) savePost();
    });
  }

  // =========================================================================
  // (7) Voice capture in the editor (stop-mode via the shared recorder)
  // =========================================================================
  function installSink() {
    window.__transcriptSink = (text) => {
      insertAtCaret(text);
      if (editingId !== null) markDirty();
      resetIdleTimer();
    };
  }
  function releaseSink() {
    if (window.__transcriptSink) window.__transcriptSink = null;
    if (els.postRecordBtn) {
      els.postRecordBtn.classList.remove("recording");
      els.postRecordBtn.textContent = "Record";
    }
  }

  function toggleRecord() {
    const vc = window.__voiceCapture;
    if (!vc) {
      setStatus("Voice capture isn't available.", "error");
      return;
    }
    if (vc.isRecording()) {
      vc.stop();
      els.postRecordBtn.classList.remove("recording");
      els.postRecordBtn.textContent = "Record";
      // Sink stays installed until the final transcript arrives; it's cleared
      // when leaving the editor/collab. Keeping it is harmless.
      return;
    }
    // Collab uses stop-mode only. Live mode writes to the private editor and
    // bypasses the sink, so turn it off before starting.
    if (els.liveToggle && els.liveToggle.checked) {
      els.liveToggle.checked = false;
      els.liveToggle.dispatchEvent(new Event("change", { bubbles: true }));
    }
    installSink();
    els.postEditor.focus();
    restoreSavedRange();
    vc.start();
    els.postRecordBtn.classList.add("recording");
    els.postRecordBtn.textContent = "Stop";
    resetIdleTimer();
  }

  if (els.postRecordBtn)
    els.postRecordBtn.addEventListener("click", toggleRecord);

  // =========================================================================
  // (8) Caret tracking + insertAtCaret
  // =========================================================================
  function saveSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (els.postEditor.contains(range.commonAncestorContainer)) {
      savedRange = range.cloneRange();
    }
  }

  function restoreSavedRange() {
    if (!savedRange) return false;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
    return true;
  }

  document.addEventListener("selectionchange", () => {
    if (!collabActive) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (els.postEditor.contains(r.commonAncestorContainer)) saveSelection();
    }
  });
  els.postEditor.addEventListener("blur", saveSelection);
  els.postEditor.addEventListener("keyup", saveSelection);
  els.postEditor.addEventListener("mouseup", saveSelection);

  // Insert text/markdown at the saved caret; append to the end as a fallback.
  function insertAtCaret(text) {
    if (!text) return;
    els.postEditor.focus();
    const restored = restoreSavedRange();
    const sel = window.getSelection();

    if (restored && sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      // Move caret to just after the inserted node.
      range.setStartAfter(node);
      range.setEndAfter(node);
      sel.removeAllRanges();
      sel.addRange(range);
      savedRange = range.cloneRange();
    } else {
      // Fallback: append at the end with a sensible separator.
      const existing = els.postEditor.innerText.replace(/\s+$/, "");
      const sep = existing.length ? " " : "";
      els.postEditor.innerText = existing + sep + text;
    }

    // Keep the in-memory post body in sync.
    if (store && editingId !== null) {
      const p = store.posts.get(editingId);
      if (p) p.body = els.postEditor.innerText;
    }
    els.postEditor.scrollTop = els.postEditor.scrollHeight;
  }

  // =========================================================================
  // (9) Insert picture (media picker modal)
  // =========================================================================
  let selectedMediaName = null;

  function openMediaModal() {
    if (!store) {
      setStatus("Connect a story folder first.", "error");
      return;
    }
    if (editingId === null) {
      setStatus("Open or create a post before inserting a picture.", "error");
      return;
    }
    saveSelection(); // remember where to drop the image
    selectedMediaName = null;
    pendingUpload = null;
    if (els.mediaAltInput) els.mediaAltInput.value = "";
    if (els.mediaUploadInput) els.mediaUploadInput.value = "";
    els.mediaPickerModal.hidden = false;
    populateMediaGrid().catch((err) =>
      setStatus("Could not list media: " + (err && err.message), "error")
    );
    resetIdleTimer();
  }

  function closeMediaModal() {
    els.mediaPickerModal.hidden = true;
    revokeMediaUrls();
    selectedMediaName = null;
    pendingUpload = null;
  }

  function revokeMediaUrls() {
    for (const url of mediaObjectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    mediaObjectUrls = [];
  }

  function baseName(name) {
    const n = String(name || "");
    const slash = Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\"));
    const file = slash >= 0 ? n.slice(slash + 1) : n;
    const dot = file.lastIndexOf(".");
    return dot > 0 ? file.slice(0, dot) : file;
  }

  async function populateMediaGrid() {
    if (!els.mediaGrid) return;
    revokeMediaUrls();
    els.mediaGrid.innerHTML = "";
    const items = await store.listMedia();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "media-grid-empty";
      empty.textContent = "No pictures yet. Upload one above.";
      els.mediaGrid.appendChild(empty);
      return;
    }
    for (const { name, handle } of items) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "media-thumb";
      cell.dataset.name = name;

      const img = document.createElement("img");
      img.alt = name;
      img.loading = "lazy";
      try {
        const file = await handle.getFile();
        const url = URL.createObjectURL(file);
        mediaObjectUrls.push(url);
        img.src = url;
      } catch {
        /* unreadable file — leave broken thumb */
      }

      const label = document.createElement("div");
      label.className = "media-thumb-name";
      label.textContent = name;

      cell.appendChild(img);
      cell.appendChild(label);
      cell.addEventListener("click", () => {
        selectedMediaName = name;
        pendingUpload = null;
        for (const c of els.mediaGrid.querySelectorAll(".media-thumb")) {
          c.classList.toggle("selected", c === cell);
        }
        if (els.mediaAltInput && !els.mediaAltInput.value) {
          els.mediaAltInput.value = baseName(name);
        }
      });

      els.mediaGrid.appendChild(cell);
    }
  }

  // Upload path: write the file as the current user's media, then pre-select it.
  async function handleUpload(file) {
    if (!file || !store) return;
    const FIVE_MB = 5 * 1024 * 1024;
    if (file.size > FIVE_MB) {
      setStatus(
        `That picture is large (${Math.round(
          file.size / (1024 * 1024)
        )} MB). Big files may sync slowly.`,
        "error"
      );
    }
    try {
      const id = newPostId(); // reuse id generator for a unique media id
      const data = await file.arrayBuffer();
      const name = await store.writeOwnMedia(id, file.name, data);
      pendingUpload = { name };
      selectedMediaName = name;
      if (els.mediaAltInput && !els.mediaAltInput.value) {
        els.mediaAltInput.value = baseName(file.name);
      }
      await populateMediaGrid();
      // Mark the just-uploaded cell selected.
      const cell = els.mediaGrid.querySelector(
        `.media-thumb[data-name="${CSS.escape(name)}"]`
      );
      if (cell) cell.classList.add("selected");
      setStatus("Picture uploaded. Add alt text, then Insert.");
    } catch (err) {
      setStatus("Upload failed: " + (err && err.message), "error");
    }
  }

  function insertSelectedMedia() {
    if (!selectedMediaName) {
      setStatus("Choose or upload a picture first.", "error");
      return;
    }
    const alt =
      (els.mediaAltInput && els.mediaAltInput.value.trim()) ||
      baseName(selectedMediaName);
    const markdown = `![${alt}](media/${selectedMediaName})`;
    closeMediaModal();
    insertAtCaret(markdown);
    if (editingId !== null) markDirty();
    setStatus("Picture reference inserted.");
    resetIdleTimer();
  }

  if (els.insertPictureBtn)
    els.insertPictureBtn.addEventListener("click", openMediaModal);
  if (els.mediaCancelBtn)
    els.mediaCancelBtn.addEventListener("click", closeMediaModal);
  if (els.mediaInsertBtn)
    els.mediaInsertBtn.addEventListener("click", insertSelectedMedia);
  if (els.mediaUploadInput)
    els.mediaUploadInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleUpload(file);
    });
  if (els.mediaPickerModal)
    els.mediaPickerModal.addEventListener("click", (e) => {
      if (e.target === els.mediaPickerModal) closeMediaModal();
    });

  // =========================================================================
  // (10) Build combined story + download + assembled preview
  // =========================================================================
  async function buildStory() {
    if (!store) {
      setStatus("Connect a story folder first.", "error");
      return;
    }
    try {
      const res = await store.buildCombinedStory();
      if (res.built) setStatus("Combined story written to story.md.", "ok");
      else if (res.skipped) setStatus("Story already up to date.", "ok");
      renderAssembled();
    } catch (err) {
      setStatus("Build failed: " + (err && err.message), "error");
    }
    resetIdleTimer();
  }

  function downloadStory() {
    if (!store) {
      setStatus("Connect a story folder first.", "error");
      return;
    }
    try {
      const text = store.assembledText();
      const blob = new Blob([text], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "story.md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setStatus("Download failed: " + (err && err.message), "error");
    }
    resetIdleTimer();
  }

  async function renderAssembled() {
    if (!els.assembledView || !store) return;
    const md = store.assembledText();
    // Safe render (escapes HTML, then applies markdown). Co-author content can't
    // inject markup.
    const html = renderMarkdown(md);
    els.assembledView.innerHTML = html;
    await resolveAssembledImages();
  }

  // Replace media/<file> image srcs with object URLs loaded from the folder, so
  // pictures actually display in the preview. Old URLs are revoked first.
  async function resolveAssembledImages() {
    for (const url of assembledUrls) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    assembledUrls = [];
    if (!store) return;

    const imgs = els.assembledView.querySelectorAll('img[src^="media/"]');
    if (!imgs.length) return;

    // Build a filename -> handle map once from the media listing.
    let media;
    try {
      media = await store.listMedia();
    } catch {
      return;
    }
    const byName = new Map(media.map((m) => [m.name, m.handle]));

    for (const img of imgs) {
      const src = img.getAttribute("src") || "";
      const name = src.replace(/^media\//, "");
      const handle = byName.get(name);
      if (!handle) {
        img.alt = (img.alt || "") + " (missing picture)";
        continue;
      }
      try {
        const file = await handle.getFile();
        const url = URL.createObjectURL(file);
        assembledUrls.push(url);
        img.src = url;
      } catch {
        /* leave broken */
      }
    }
  }

  if (els.buildStoryBtn) els.buildStoryBtn.addEventListener("click", buildStory);
  if (els.downloadStoryBtn)
    els.downloadStoryBtn.addEventListener("click", downloadStory);

  // =========================================================================
  // (11) Idle auto-build (~30s of inactivity)
  // =========================================================================
  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }
  function resetIdleTimer() {
    clearIdleTimer();
    if (!collabActive) return;
    idleTimer = setTimeout(fireIdleBuild, IDLE_BUILD_MS);
  }
  function scheduleIdleBuild() {
    resetIdleTimer();
  }
  async function fireIdleBuild() {
    if (!store) return;
    try {
      // buildCombinedStory self-skips if nothing changed, so this is cheap.
      await store.buildCombinedStory();
      renderAssembled();
    } catch {
      /* ignore idle build errors; next activity will retry */
    }
  }

  // =========================================================================
  // Bootstrap
  // =========================================================================
  loadPenName();
  reflectConnectUI();
  // Attempt silent restore of a previously connected folder.
  restoreFolder().catch(() => {});
}
