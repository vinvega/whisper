// Unit tests for collab-store.js using an in-memory File System Access mock.
// Run: node collab-store.test.mjs
import { createCollabStore } from "./collab-store.js";
import { serializePost, postFileName } from "./collab-core.js";

// ---------------------------------------------------------------------------
// In-memory directory handle mock (subset of FileSystemDirectoryHandle)
// ---------------------------------------------------------------------------
let clock = 1000;
function makeFileHandle(store, name) {
  return {
    kind: "file",
    name,
    async getFile() {
      const rec = store.get(name);
      if (!rec) { const e = new Error("nf"); e.name = "NotFoundError"; throw e; }
      return {
        name,
        lastModified: rec.lastModified,
        size: rec.size,
        text: async () => rec.text,
      };
    },
    async createWritable() {
      let buf = "";
      return {
        write: async (chunk) => { buf += typeof chunk === "string" ? chunk : String(chunk); },
        close: async () => { store.set(name, { text: buf, lastModified: ++clock, size: buf.length }); },
      };
    },
  };
}
function makeDir() {
  const files = new Map();   // name -> {text,lastModified,size}
  const subdirs = new Map(); // name -> dirHandle
  const dir = {
    kind: "directory",
    _files: files,
    async getDirectoryHandle(name, opts) {
      if (!subdirs.has(name)) {
        if (opts && opts.create) subdirs.set(name, makeDir());
        else { const e = new Error("nf"); e.name = "NotFoundError"; throw e; }
      }
      return subdirs.get(name);
    },
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (opts && opts.create) files.set(name, { text: "", lastModified: ++clock, size: 0 });
        else { const e = new Error("nf"); e.name = "NotFoundError"; throw e; }
      }
      return makeFileHandle(files, name);
    },
    async removeEntry(name) { files.delete(name); },
    async *entries() {
      for (const name of files.keys()) yield [name, makeFileHandle(files, name)];
    },
  };
  return dir;
}

// Seed a post file directly into posts/ (simulating a co-author or prior write).
async function seedPost(root, post) {
  const posts = await root.getDirectoryHandle("posts", { create: true });
  const name = postFileName(post);
  const fh = await posts.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(serializePost(post));
  await w.close();
  return name;
}

let passed = 0;
function assert(c, m) { if (!c) { console.log("FAIL:", m); process.exit(1); } passed++; console.log("ok:", m); }

const P = (over = {}) => ({
  id: "id-" + Math.random().toString(36).slice(2, 7),
  author: "Vin Vega",
  created: "2026-10-01T10:00:00.000Z",
  order: 1000,
  updated: "2026-10-01T10:00:00.000Z",
  body: "hello",
  ...over,
});

// ---------------------------------------------------------------------------
async function run() {
  // --- applyRefresh: multi-author load + ownership marking ---
  {
    const root = makeDir();
    await seedPost(root, P({ id: "mine1", author: "Vin Vega", order: 100, body: "mine" }));
    await seedPost(root, P({ id: "theirs1", author: "Co Author", order: 200, body: "theirs" }));

    const store = createCollabStore(root, "Vin Vega");
    await store.applyRefresh();

    assert(store.posts.size === 2, "applyRefresh loads both authors' posts");
    assert(store.posts.get("mine1").mine === true, "own post marked mine");
    assert(store.posts.get("theirs1").mine === false, "co-author post marked not mine");
  }

  // --- applyRefresh: a disappearing file is dropped ---
  {
    const root = makeDir();
    const nameA = await seedPost(root, P({ id: "a", order: 1, body: "A" }));
    await seedPost(root, P({ id: "b", order: 2, body: "B" }));
    const store = createCollabStore(root, "Vin Vega");
    await store.applyRefresh();
    assert(store.posts.size === 2, "both posts present initially");

    const posts = await root.getDirectoryHandle("posts");
    await posts.removeEntry(nameA);
    await store.applyRefresh();
    assert(!store.posts.has("a") && store.posts.has("b"), "vanished file dropped on refresh");
  }

  // --- detectChanges: read-only, does not mutate posts map ---
  {
    const root = makeDir();
    await seedPost(root, P({ id: "x", order: 1, body: "X" }));
    const store = createCollabStore(root, "Vin Vega");
    await store.applyRefresh();
    const sizeBefore = store.posts.size;

    // A co-author adds a post AFTER the last refresh.
    await seedPost(root, P({ id: "y", author: "Co Author", order: 2, body: "Y" }));
    const diff = await store.detectChanges();
    assert(diff.added === 1 && diff.total === 1, "detectChanges reports 1 added");
    assert(store.posts.size === sizeBefore, "detectChanges did NOT mutate the posts map");
    assert(!store.posts.has("y"), "undetected-until-refresh: new post not applied by detect");

    await store.applyRefresh();
    assert(store.posts.has("y"), "applyRefresh then picks up the new post");
  }

  // --- writeOwnPost: writes file, records sync, ownership enforced ---
  {
    const root = makeDir();
    const store = createCollabStore(root, "Vin Vega");
    const res = await store.writeOwnPost(P({ id: "w1", author: "Vin Vega", order: 500, body: "draft" }));
    assert(res.ok === true, "writeOwnPost succeeds for own post");
    const posts = await root.getDirectoryHandle("posts");
    const names = [];
    for await (const [n] of posts.entries()) names.push(n);
    assert(names.some((n) => n.includes("__vin-vega__w1.md")), "post file written with owner-scoped name");

    // Refusing to write someone else's post.
    let threw = false;
    try { await store.writeOwnPost(P({ id: "w2", author: "Co Author" })); } catch { threw = true; }
    assert(threw, "writeOwnPost refuses a post owned by another author");
  }

  // --- writeOwnPost: reorder renames file and removes the old one ---
  {
    const root = makeDir();
    const store = createCollabStore(root, "Vin Vega");
    await store.writeOwnPost(P({ id: "r1", author: "Vin Vega", order: 100, body: "v1" }));
    const posts = await root.getDirectoryHandle("posts");
    const before = [];
    for await (const [n] of posts.entries()) before.push(n);

    // Reorder (changes order -> changes filename).
    const current = store.posts.get("r1");
    await store.writeOwnPost({ ...current, order: 999 });
    const after = [];
    for await (const [n] of posts.entries()) after.push(n);
    assert(after.length === 1, "reorder leaves exactly one file (old removed)");
    assert(after[0] !== before[0], "reorder produced a new filename");
    assert(after[0].includes("__vin-vega__r1.md"), "stable id retained across reorder");
  }

  // --- writeOwnPost: external change -> conflict, no clobber; keep-mine makes .bak ---
  {
    const root = makeDir();
    const store = createCollabStore(root, "Vin Vega");
    await store.writeOwnPost(P({ id: "c1", author: "Vin Vega", order: 100, body: "original" }));
    const current = store.posts.get("c1");
    const name = current.sync.fileName;

    // Simulate an external edit to that file (newer lastModified/size).
    const posts = await root.getDirectoryHandle("posts");
    const fh = await posts.getFileHandle(name);
    const w = await fh.createWritable();
    await w.write(serializePost({ ...current, body: "EXTERNALLY EDITED, longer body here" }));
    await w.close();

    const res = await store.writeOwnPost({ ...current, body: "my new text" });
    assert(res.ok === false && res.conflict === true, "external change -> conflict (no clobber)");
    const fileNow = (await (await posts.getFileHandle(name)).getFile()).text ? await (await (await posts.getFileHandle(name)).getFile()).text() : "";
    assert(fileNow.includes("EXTERNALLY EDITED"), "conflicting file not overwritten");

    // Keep mine: backs up external version, then writes ours.
    const keep = await store.resolveKeepMine({ ...current, body: "my new text" });
    assert(keep.ok === true, "resolveKeepMine writes our version");
    const names = [];
    for await (const [n] of posts.entries()) names.push(n);
    assert(names.some((n) => n.includes(".bak-")), "keep-mine created a .bak backup");
  }

  // --- deleteOwnPost removes file; refuses others ---
  {
    const root = makeDir();
    const store = createCollabStore(root, "Vin Vega");
    await store.writeOwnPost(P({ id: "d1", author: "Vin Vega", order: 1, body: "bye" }));
    await store.deleteOwnPost("d1");
    assert(!store.posts.has("d1"), "deleteOwnPost removes from map");
    const posts = await root.getDirectoryHandle("posts");
    const names = [];
    for await (const [n] of posts.entries()) names.push(n);
    assert(names.length === 0, "deleteOwnPost removes the file");
  }

  // --- editing post is not clobbered by refresh ---
  {
    const root = makeDir();
    await seedPost(root, P({ id: "e1", author: "Vin Vega", order: 1, body: "on disk" }));
    const store = createCollabStore(root, "Vin Vega");
    await store.applyRefresh();
    store.setEditing("e1");
    store.posts.get("e1").body = "unsaved edits in progress";
    await store.applyRefresh();
    assert(store.posts.get("e1").body === "unsaved edits in progress",
      "refresh does not overwrite the body of the post being edited");
  }

  // --- media: owner-scoped write, listing, delete ownership guard ---
  {
    const root = makeDir();
    const store = createCollabStore(root, "Vin Vega");
    const mname = await store.writeOwnMedia("mid1", "Photo.PNG", "binarydata");
    assert(mname === "vin-vega__mid1__photo.png", "writeOwnMedia uses owner-scoped safe name");
    const media = await store.listMedia();
    assert(media.length === 1 && media[0].name === mname, "listMedia lists the media file");

    let threw = false;
    try { await store.deleteOwnMedia("co-author__x__pic.png"); } catch { threw = true; }
    assert(threw, "deleteOwnMedia refuses a co-author's media");
    await store.deleteOwnMedia(mname);
    assert((await store.listMedia()).length === 0, "deleteOwnMedia removes own media");
  }

  // --- buildCombinedStory: writes story.md, skips identical, no conflict path ---
  {
    const root = makeDir();
    await seedPost(root, P({ id: "s1", author: "Vin Vega", order: 1, body: "Chapter one." }));
    await seedPost(root, P({ id: "s2", author: "Co Author", order: 2, body: "Chapter two." }));
    const store = createCollabStore(root, "Vin Vega");
    await store.applyRefresh();

    const r1 = await store.buildCombinedStory();
    assert(r1.built === true, "buildCombinedStory writes on first build");
    const storyText = await (await root.getFileHandle("story.md")).getFile().then((f) => f.text());
    assert(storyText === "Chapter one.\n\nChapter two.", "story.md assembled in order across authors");

    const r2 = await store.buildCombinedStory();
    assert(r2.skipped === true && r2.built === false, "identical rebuild is skipped");
  }

  // --- buildCombinedStory overwrites a co-author's story.md with no conflict ---
  {
    const root = makeDir();
    // Pre-seed an existing story.md (as if a co-author built it).
    const fh = await root.getFileHandle("story.md", { create: true });
    const w = await fh.createWritable();
    await w.write("stale content from someone else");
    await w.close();

    await seedPost(root, P({ id: "o1", author: "Vin Vega", order: 1, body: "fresh" }));
    const store = createCollabStore(root, "Vin Vega");
    await store.applyRefresh();
    const r = await store.buildCombinedStory();
    assert(r.built === true, "overwrites existing story.md without a conflict prompt");
    const t = await (await root.getFileHandle("story.md")).getFile().then((f) => f.text());
    assert(t === "fresh", "story.md replaced with current assembly (last-writer-wins)");
  }

  // --- INTEGRATION: two authors, same folder, identical deterministic assembly ---
  {
    const root = makeDir(); // one shared folder (simulating Drive-synced files)

    // Author A writes a post.
    const a = createCollabStore(root, "Author A");
    await a.applyRefresh();
    await a.writeOwnPost(P({ id: "pA", author: "Author A", order: 100, body: "Alpha paragraph." }));

    // Author B writes a post into the SAME folder.
    const b = createCollabStore(root, "Author B");
    await b.applyRefresh();
    await b.writeOwnPost(P({ id: "pB", author: "Author B", order: 50, body: "Beta paragraph (earlier)." }));

    // Both refresh to see each other's files.
    await a.applyRefresh();
    await b.applyRefresh();

    assert(a.posts.size === 2 && b.posts.size === 2, "both authors see both posts");
    // Neither clobbered the other: both files exist.
    const posts = await root.getDirectoryHandle("posts");
    const names = [];
    for await (const [n] of posts.entries()) names.push(n);
    assert(names.some((n) => n.includes("__author-a__pA.md")), "author A's file intact");
    assert(names.some((n) => n.includes("__author-b__pB.md")), "author B's file intact");

    // Assembly is identical for both and respects order (B's 50 before A's 100).
    const asmA = a.assembledText();
    const asmB = b.assembledText();
    assert(asmA === asmB, "both authors compute an identical assembled document");
    assert(asmA === "Beta paragraph (earlier).\n\nAlpha paragraph.",
      "assembly ordered by `order` across authors: " + JSON.stringify(asmA));

    // Ownership: A cannot write B's post.
    let refused = false;
    try { await a.writeOwnPost(P({ id: "pB", author: "Author B", body: "hijack" })); } catch { refused = true; }
    assert(refused, "author A refused to write author B's post (single-writer)");
  }

  console.log(`\nALL ${passed} COLLAB-STORE TESTS PASSED`);
}

run().catch((e) => { console.log("ERROR:", e.stack || e.message); process.exit(1); });
