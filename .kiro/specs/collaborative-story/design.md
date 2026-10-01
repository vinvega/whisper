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
- `assemble()` is the single source of the combined document, used by the in-app
  assembled view, the `story.md` build, and local export alike.

### 5.1a Building the combined story (`story.md`) — Req 7

The combined document is a **derived output**. "Building" means running `assemble()`
over the posts the user currently has loaded and writing the result to `story.md`.

```
buildCombinedStory(reason):            # reason = "manual" | "idle"
    md = assemble(posts)               # over currently-synced posts in memory
    if md === lastBuiltContent: return # skip identical rebuilds (Req 7.3)
    write md to <folder>/story.md      # OUTPUT; NOT via writeOwnPost / no conflict/.bak
    lastBuiltContent = md
    show brief "Combined story updated" status
```

Key points:
- Assembles from the **in-memory, currently-synced** posts, so the output reflects
  the user's current view (Req 7.2). It does NOT force a refresh first; the UI tells
  the user to Refresh if they want co-authors' latest included.
- `story.md` bypasses the owned-file machinery entirely: it is written directly,
  with **no** external-change detection, **no** `.bak`, and **no** single-writer
  check (Req 7.5, 7.6). It is pure output; last-writer-wins is acceptable because
  the posts remain the source of truth and the content is deterministic.
- `lastBuiltContent` guards against rewriting an identical file (Req 7.3), which
  also prevents the idle task from needlessly churning Drive syncs.

**Idle auto-build (Req 7.3-7.4):**

```
idle timer (default 30s):
    reset on: typing, post edit, voice capture, navigation, refresh
    on fire (user idle):
        if connected to a story folder:
            buildCombinedStory("idle")   # no-op if nothing changed
```

- The timer is reset by the same activity signals that already drive the editor; a
  single debounced "activity" hook resets it.
- The idle build is best-effort and silent on no-change; it never blocks editing,
  recording, or refresh (Req 7.9).

**Local export (Req 7.8):** the same `assemble()` output can be offered as a `.md`
download (reusing the existing export/download mechanism), independent of the folder
`story.md`.

### 5.2 Scan + refresh model (manual primary, notify-only background)

Two distinct operations (Req 3a):

**`detectChanges()` — read-only probe, used by the background check.** Cheap: list
`posts/` and `media/`, compare the set of filenames + each file's `lastModified`/
`size` against a lightweight snapshot taken at the last applied refresh. Returns a
count/summary of what differs. Does NOT touch the view or the posts map.

```
detectChanges():
    current = list(posts/) with {name, lastModified, size}
    diff = compare(current, lastAppliedSnapshot)   # added / changed / removed
    return diff   # e.g. { added: 2, changed: 1, removed: 0 }
```

**`applyRefresh()` — the actual load, used by manual Refresh and the indicator.**

```
applyRefresh():
    for each *.md in posts/:
        parse front-matter + body
        mark mine = slug(author) === penSlug
        upsert into posts map   # others' posts: read-only inputs
    remove posts whose files disappeared (unless it is the post being edited; keep
        the in-progress editor content, flag separately)
    recompute lastAppliedSnapshot
    clear the "updates available" indicator
    re-render list + assembled view
```

**Background loop (notify-only):**

```
on interval (e.g. ~20s):
    diff = detectChanges()
    if diff has any changes:
        show indicator "N updates — Refresh"   # does NOT applyRefresh()
```

Rules enforcing Req 3a:
- The background loop only ever calls `detectChanges()` + shows an indicator; it
  never calls `applyRefresh()` on its own while editing.
- The post currently being edited is never overwritten by a refresh; its unsaved
  body is preserved. (If that same file also changed on disk — the user's own post
  edited elsewhere — it is the existing own-post conflict case: Keep mine / Load
  from folder, surfaced on save, not silently applied.)
- When the user is only viewing the assembled doc (not editing), `applyRefresh()`
  MAY run automatically; it still never discards unsaved edits.
- Own posts: compare file `lastModified`/`size` to stored `sync` → if changed
  externally, raise the existing conflict flow (`.bak` safety) rather than clobber.
- Manual Refresh and the indicator both call `applyRefresh()`.

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
- **Post list**: shows ALL posts (own + co-authors') with author attribution,
  always visible alongside the editor so the whole-story context is retained while
  writing; the user's own posts are editable/reorderable/deletable, others' are
  read-only.
- **Refresh control + "updates available" indicator**: a manual Refresh button; the
  background check surfaces an unobtrusive "N updates — Refresh" badge that applies
  changes only when clicked (§5.2, Req 3a).
- **Assembled view**: read-only rendered document.
- **Build combined story**: button to write `story.md` from the current view (§5.1a);
  plus a local `.md` export. An idle timer also rebuilds `story.md` after ~30s of
  inactivity.
- **Insert picture**: button in the post editor; see §8.1.
- **Conflict badges** on the user's own posts (reusing the existing pattern).

### 8.1 Insert-picture flow

Goal: add a new image or reuse an existing one, inserting the correct markdown at
the caret (Req 5a).

**Caret tracking.** The post body editor is a `contenteditable`. Programmatic
updates (voice transcription, inserts) and focus changes can lose the caret, so we
persist the last-known selection:

```
on 'selectionchange' / editor blur:
    if selection is inside the post-body editor:
        savedRange = selection.getRangeAt(0).cloneRange()
```

On insert, restore `savedRange` (or fall back to end-of-body if none) and splice the
markdown there.

**Listing the media library (Req 5a.3).** Enumerate `media/` in the story folder and
list all files (any author's), each with a small thumbnail (object URL from the
file). This is a read listing; it does not imply write/delete rights over others'
files.

**Insert flow:**

```
insertPicture():
    choice = ask user: "Upload new" | "Choose existing"
    if Upload new:
        file = file picker (image/*)
        warn if over size threshold (Req 5.6)
        name = mediaFileName(penSlug, newId, file.name)   # owner-scoped
        write file to media/<name>                        # owner write only
    else: # Choose existing
        name = user picks from media/ listing (may be a co-author's file; no copy)
    alt = prompt (default = file base name)                # Req 5a.6
    md = `![${alt}](media/${name})`
    insertAtCaret(editorBody, md, savedRange)              # Req 5a.4 / fallback 5a.5
    # editing the body marks the post dirty -> writeOwnPost (the POST is owned;
    # referencing a co-author's media does not write their file) (Req 5a.7/5a.8)
```

Key invariants:
- Choosing an existing image inserts a reference only — **no file copy** (5a.7).
- Only the post file (owned) is written; referenced media owned by others is never
  modified (5a.8).
- `insertAtCaret` uses the saved range; absent one, appends to the body (5a.5).

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
