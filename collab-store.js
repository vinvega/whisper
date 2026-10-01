// Collaborative story — storage layer over a shared folder (File System Access API).
//
// Depends on collab-core.js for pure logic. This module performs the file I/O:
// reading/writing post files in <story>/posts/ and enforcing single-writer
// ownership. It is written to work against any object implementing the subset of
// the FileSystemDirectoryHandle API we use, so it can be unit-tested with a mock.
//
// Design (see .kiro/specs/collaborative-story/design.md):
//  - localStorage/private notes are untouched; this is a parallel subsystem.
//  - Only the user's own posts/media are ever written (single-writer-per-file).
//  - applyRefresh() loads the current folder state; detectChanges() is a read-only
//    probe for the notify-only background check (never mutates the posts map).
//  - writeOwnPost() reuses external-change detection, a .bak safety copy on
//    conflict, and rename cleanup — mirroring the private-notes sync guarantees.

import {
  penSlug,
  parsePost,
  serializePost,
  postFileName,
  isOwnedBy,
  mediaFileName,
} from "./collab-core.js";

const POSTS_DIR = "posts";
const MEDIA_DIR = "media";

export function createCollabStore(dirHandle, penName) {
  const slug = penSlug(penName);

  const store = {
    dirHandle,
    penName,
    slug,
    posts: new Map(),       // id -> post (+ mine, fileName, sync)
    snapshot: new Map(),     // fileName -> { lastModified, size } at last applyRefresh
    editingId: null,         // id of the post currently being edited (never clobbered)
  };

  // --- directory helpers ------------------------------------------------------
  async function postsDir(create = false) {
    return dirHandle.getDirectoryHandle(POSTS_DIR, { create });
  }
  async function mediaDir(create = false) {
    return dirHandle.getDirectoryHandle(MEDIA_DIR, { create });
  }

  // List post files as [{ name, handle }]. Returns [] if posts/ doesn't exist yet.
  async function listPostFiles() {
    let dir;
    try {
      dir = await postsDir(false);
    } catch (err) {
      if (err && err.name === "NotFoundError") return [];
      throw err;
    }
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && name.endsWith(".md")) {
        out.push({ name, handle });
      }
    }
    return out;
  }

  async function statFile(handle) {
    const file = await handle.getFile();
    return { lastModified: file.lastModified, size: file.size, file };
  }

  // --- 2.2a detectChanges: read-only probe for the background check -----------
  // Compares current post files against the last-applied snapshot WITHOUT touching
  // the posts map. Returns counts so the UI can show "N updates — Refresh".
  async function detectChanges() {
    const files = await listPostFiles();
    const current = new Map();
    for (const { name, handle } of files) {
      const { lastModified, size } = await statFile(handle);
      current.set(name, { lastModified, size });
    }

    let added = 0;
    let changed = 0;
    for (const [name, cur] of current) {
      const prev = store.snapshot.get(name);
      if (!prev) added++;
      else if (prev.lastModified !== cur.lastModified || prev.size !== cur.size) changed++;
    }
    let removed = 0;
    for (const name of store.snapshot.keys()) {
      if (!current.has(name)) removed++;
    }
    return { added, changed, removed, total: added + changed + removed };
  }

  // --- 2.2 applyRefresh: load folder state into the posts map -----------------
  async function applyRefresh() {
    const files = await listPostFiles();
    const seen = new Set();
    const nextSnapshot = new Map();

    for (const { name, handle } of files) {
      const { lastModified, size, file } = await statFile(handle);
      nextSnapshot.set(name, { lastModified, size });

      const text = await file.text();
      const post = parsePost(text);
      if (!post) continue; // malformed/partial — skip, retried next refresh

      seen.add(post.id);

      // Never overwrite the body of the post the user is actively editing.
      if (post.id === store.editingId && store.posts.has(post.id)) {
        const existing = store.posts.get(post.id);
        // Still refresh its on-disk sync info so a later save can detect conflicts,
        // but keep the in-progress (possibly unsaved) body.
        existing.sync = { lastModified, size, fileName: name };
        continue;
      }

      post.mine = isOwnedBy(name, slug);
      post.fileName = name;
      post.sync = { lastModified, size, fileName: name };
      store.posts.set(post.id, post);
    }

    // Drop posts whose files vanished — except the one being edited.
    for (const id of [...store.posts.keys()]) {
      if (!seen.has(id) && id !== store.editingId) {
        store.posts.delete(id);
      }
    }

    store.snapshot = nextSnapshot;
    return store.posts;
  }

  // --- 2.3 writeOwnPost: single-writer, external-change-safe, rename cleanup --
  async function writeOwnPost(post) {
    assertOwned(post.author);

    const dir = await postsDir(true);
    const newName = postFileName(post);
    const existing = store.posts.get(post.id);
    const oldName = existing && existing.sync && existing.sync.fileName;

    // External-change detection: if the on-disk file we last wrote changed since,
    // do not clobber — signal a conflict for the caller to resolve.
    if (oldName) {
      const changed = await fileChangedExternally(dir, oldName, existing.sync);
      if (changed) {
        return { ok: false, conflict: true, fileName: oldName };
      }
    }

    const body = serializePost(post);
    const fh = await dir.getFileHandle(newName, { create: true });
    const w = await fh.createWritable();
    await w.write(body);
    await w.close();
    const { lastModified, size } = await statFile(fh);

    const saved = {
      ...post,
      mine: true,
      fileName: newName,
      sync: { lastModified, size, fileName: newName },
    };
    store.posts.set(post.id, saved);
    store.snapshot.set(newName, { lastModified, size });

    // Rename cleanup: remove the orphaned old file after the new one is written.
    if (oldName && oldName !== newName) {
      try {
        await dir.removeEntry(oldName);
      } catch {
        /* already gone */
      }
      store.snapshot.delete(oldName);
    }

    return { ok: true, post: saved };
  }

  // Keep-mine conflict resolution: back up the external version, then write ours.
  async function resolveKeepMine(post) {
    assertOwned(post.author);
    const dir = await postsDir(true);
    const name = postFileName(post);
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      const text = await file.text();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const bakName = name.replace(/\.md$/, `.bak-${stamp}.md`);
      const bh = await dir.getFileHandle(bakName, { create: true });
      const bw = await bh.createWritable();
      await bw.write(text);
      await bw.close();
    } catch {
      /* no existing file to back up */
    }
    // Force the write by clearing stale sync, then writing.
    const existing = store.posts.get(post.id);
    if (existing && existing.sync) existing.sync = null;
    return writeOwnPost(post);
  }

  async function loadFromFolder(id) {
    const dir = await postsDir(false);
    const existing = store.posts.get(id);
    const name = existing && existing.sync && existing.sync.fileName;
    if (!name) return null;
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    const post = parsePost(await file.text());
    if (!post) return null;
    post.mine = isOwnedBy(name, slug);
    post.fileName = name;
    post.sync = { lastModified: file.lastModified, size: file.size, fileName: name };
    store.posts.set(id, post);
    return post;
  }

  // --- 2.4 single-writer: delete own post -------------------------------------
  async function deleteOwnPost(id) {
    const post = store.posts.get(id);
    if (!post) return;
    assertOwned(post.author);
    const name = (post.sync && post.sync.fileName) || postFileName(post);
    try {
      const dir = await postsDir(false);
      await dir.removeEntry(name);
    } catch {
      /* already gone */
    }
    store.posts.delete(id);
    store.snapshot.delete(name);
  }

  // --- media ------------------------------------------------------------------
  async function writeOwnMedia(id, originalName, data) {
    const name = mediaFileName(slug, id, originalName);
    const dir = await mediaDir(true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
    return name; // caller inserts media/<name> reference
  }

  // List all media (any author) for the picker. Read-only; no ownership implied.
  async function listMedia() {
    let dir;
    try {
      dir = await mediaDir(false);
    } catch (err) {
      if (err && err.name === "NotFoundError") return [];
      throw err;
    }
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") out.push({ name, handle });
    }
    return out;
  }

  async function deleteOwnMedia(name) {
    // Media ownership is encoded as the leading "<slug>__" segment.
    if (!name.startsWith(slug + "__")) {
      throw new Error("Refusing to delete media owned by another author");
    }
    try {
      const dir = await mediaDir(false);
      await dir.removeEntry(name);
    } catch {
      /* already gone */
    }
  }

  // --- helpers ----------------------------------------------------------------
  function assertOwned(author) {
    if (penSlug(author) !== slug) {
      throw new Error("Refusing to write a post owned by another author");
    }
  }

  async function fileChangedExternally(dir, name, lastSync) {
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return file.lastModified !== lastSync.lastModified || file.size !== lastSync.size;
    } catch (err) {
      if (err && err.name === "NotFoundError") return false; // gone -> recreate, not a conflict
      throw err;
    }
  }

  function setEditing(id) {
    store.editingId = id;
  }

  return {
    state: store,
    detectChanges,
    applyRefresh,
    writeOwnPost,
    resolveKeepMine,
    loadFromFolder,
    deleteOwnPost,
    writeOwnMedia,
    listMedia,
    deleteOwnMedia,
    setEditing,
    get posts() {
      return store.posts;
    },
  };
}
