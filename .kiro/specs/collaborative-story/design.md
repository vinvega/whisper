# Design — Collaborative Story Writing

## 1. Guiding principle

**One markdown file per post; exactly one writer per file.** Every collaborator's
app writes only the files it owns (its own posts and media). The shared document is
a *derived view* produced by reading all post files and ordering them.

This is the single idea the whole design rests on. It converts "collaborative
editing" (hard: concurrent mutation of shared state → requires CRDT/OT) into
"collaborative appending of independently-owned files" (easy: disjoint writers,
commutative adds, deterministic assembly).

### Why this is collision-free (the correctness argument)

- The only shared mutable state is **the set of files in the folder**.
- Each file has a **single writer** (the author whose pen name owns it). No two apps
  ever write the same file, so there is no write-write conflict on content.
- Adding files is **commutative**: the order in which collaborator A's app observes
  B's new posts does not change the result, because assembly re-sorts by an explicit
  `order` key with a deterministic tiebreak.
- Therefore every collaborator, given the same set of files, computes an
  **identical** assembled document. No merge of text is ever required.

The only residual coordination is *ordering*, which is a total order over
independent items (a soft problem) rather than a merge of overlapping edits (the
hard problem). Ties are broken deterministically so even that converges.

## 2. Storage layout

A **story** is a folder (typically inside a shared Google Drive mount) chosen via
the existing File System Access API:

```
<story folder>/
  posts/
    0001696170600__vinvega__a1b2c3.md
    0001696170730__coauthor__d4e5f6.md
  media/
    vinvega__a1b2c3__lighthouse.png
  story.md            # OPTIONAL regenerated output (never read as source)
  .collab.json        # OPTIONAL story metadata (title); see §6
```

### 2.1 Post file format

YAML front-matter + markdown body:

```markdown
---
id: a1b2c3
author: VinVega
created: 2026-10-01T14:30:00.000Z
order: 1696170600
updated: 2026-10-01T14:31:10.000Z
---
The old lighthouse had not blinked in thirty years...

![storm](media/vinvega__a1b2c3__lighthouse.png)
```

Front-matter fields:

| Field | Purpose |
|-------|---------|
| `id` | Unique per-post id (base36 time + random). Immutable. |
| `author` | Display pen name (human-readable, preserved verbatim). |
| `created` | ISO timestamp, immutable. |
| `order` | Numeric sort key (default = created epoch ms). User-editable for own posts. |
| `updated` | ISO timestamp of last write (helps displays; not used for merge). |

### 2.2 Post filename

```
<order padded>__<penSlug>__<id>.md
```

- `order padded` — zero-padded numeric `order` so a plain filename sort approximates
  reading order (assembly still re-sorts authoritatively by front-matter).
- `penSlug` — the author's pen name reduced to `[a-z0-9-]`.
- `id` — the unique id, guaranteeing no collision even if two authors share a pen
  name or an `order`.

Only the owning app writes files matching its own `penSlug`+`id`. Reordering changes
the `order` field (and may rename the file); since both the old and new names carry
the owner's `id`, the owner cleans up its own old file (reusing the existing
rename-cleanup mechanism).

### 2.3 Media filename

```
media/<penSlug>__<id>__<safe-original-name>
```

Owner-scoped by `penSlug`+`id`, so media never collides across authors. A post
references media by relative path so the raw folder and the assembled document are
both portable.

## 3. Identity: pen name

- Stored in `localStorage` under `voice-notes:penName` (display) and derived
  `penSlug`.
- Prompted once on entering collaboration mode; editable in settings.
- Ownership test: a post is editable iff `slug(post.author) === penSlug`. This is a
  **UI/trust-level** guard (it prevents the app from writing others' files); it is
  not a security boundary (anyone with folder access could edit any file manually).
  That is acceptable for a trusted-collaborator, shared-Drive scenario and is called
  out as a limitation.

## 4. Data model (in app)

```
collabState = {
  mode: "collab" | "private",     // explicit, opt-in
  penName, penSlug,
  storyDirHandle,                 // FileSystemDirectoryHandle (persisted in IndexedDB)
  posts: Map<id, {
    id, author, created, order, updated,
    body,
    fileName,                     // current on-disk name
    mine: boolean,                // slug(author) === penSlug
    sync: { lastModified, size }, // for external-change detection (own posts)
  }>,
}
```

The private-notes model (localStorage `voice-notes:index` etc.) is untouched;
collaboration is a parallel subsystem reusing the sync primitives.

## 5. Core algorithms

### 5.1 Assembly (derive the document)

```
function assemble(posts):
    list = posts.values()
    list.sort(by order ASC, then created ASC, then id ASC)   # deterministic
    return list.map(renderPostBody).join("\n\n")
```

- Pure function of the file set → identical output for every collaborator.
- Rendered as read-only; never edited directly.

### 5.2 Scan (pick up collaborators' changes)

```
on interval / on demand:
    for each *.md in posts/:
        parse front-matter + body
        mark mine = slug(author) === penSlug
        upsert into posts map
    remove posts whose files disappeared
    re-render assembled view
```

- Others' posts are read-only inputs: scanning them never raises a conflict.
- Own posts: compare file lastModified/size to stored `sync` → if changed
  externally, raise the existing conflict flow (Keep mine / Load from folder, with
  `.bak`).

### 5.3 Write own post

```
writePost(post):
    if externally changed since last write -> conflict flow (no clobber)
    else:
        serialize front-matter + body
        write to <new filename>
        record sync {lastModified, size}
        if filename changed (reorder/rename) -> remove old owned file
```

### 5.4 Ordering & reorder

- Default `order` = `created` epoch ms, so posts naturally append in time order.
- Reordering a user's own post sets a new `order` (e.g. midpoint between neighbors,
  or an explicit index) and rewrites only that post's file.
- Tiebreak `created` then `id` guarantees convergence if two authors pick equal
  `order` values.
- A user can only reorder their **own** posts; they cannot move a co-author's post
  (that would require writing someone else's file). Global interleaving emerges from
  each author's chosen `order` values plus the deterministic sort.

## 6. Optional story metadata

`.collab.json` MAY hold shared, low-contention metadata (e.g. story title). To keep
single-writer discipline, treat it as owned by whoever created the story, or avoid
it initially and derive the title from the folder name. Not required for v1.

## 7. Reuse of existing components

| Existing piece | Reused for |
|----------------|-----------|
| File System Access + IndexedDB handle persistence | Choosing/persisting the story folder |
| External-change detection (`lastModified`+`size`) | Protecting the user's own posts |
| `.bak` safety copy on Keep-mine | Same safety net for posts |
| Rename cleanup (stable id in filename) | Reorder-driven filename changes |
| Voice transcription (Live + stop) | Dictating post bodies |
| Non-speech filtering | Clean post text |

New components: front-matter (de)serialization, pen-name identity, assembly/scan,
collab-mode UI (post list grouped/attributed by author, assembled view, media
attach), markdown rendering for the assembled preview.

## 8. UI surfaces (high level)

- **Mode switch**: Private notes ↔ Collaboration (opt-in; private remains default).
- **Pen name setup/field.**
- **Connect story folder** (reuses folder picker).
- **Post list**: shows all posts with author attribution; the user's own posts are
  editable/reorderable/deletable; others' are read-only.
- **Assembled view**: read-only rendered document; export button.
- **Media attach**: add image to a post; inserts a relative markdown reference.
- **Conflict badges** on the user's own posts (reusing the existing pattern).

## 9. Edge cases & decisions

- **Same pen name as co-author:** allowed; `id` keeps files unique and ownership
  tests still work per-file (you may be able to edit a file you didn't create if
  slugs collide — documented limitation; recommend distinct pen names).
- **Equal `order`:** deterministic tiebreak (`created`, then `id`).
- **Simultaneous reorder by both:** each only rewrites their own files; assembly
  still converges via tiebreak. Visual order may differ transiently until Drive
  syncs, then converges.
- **Malformed/partial post file (mid-sync):** parser tolerates failure and skips the
  file that scan; retried next scan (same resilience approach as live decode).
- **Large media:** warn above a threshold; rely on Drive for the actual transfer.
- **Non-Chromium browser:** collaboration (folder-backed) is unavailable, same
  graceful degradation as existing folder sync; private notes still work.

## 10. Security / trust note

This is designed for **trusted collaborators sharing a Drive folder**. Ownership is
enforced by the app, not by the filesystem — anyone with folder access can edit any
file outside the app. There is no authentication layer. This is acceptable for the
intended personal/small-group use and is stated as an explicit limitation.
