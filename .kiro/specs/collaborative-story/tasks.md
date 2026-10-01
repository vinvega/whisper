# Implementation Plan — Collaborative Story Writing

Incremental, test-driven tasks. Each builds on the previous and reuses existing
sync/transcription code. Private single-user notes must keep working throughout
(Req 8). Each task notes the requirements it satisfies.

Pure logic (front-matter parsing, assembly, ordering, identity) is unit-testable in
Node with the existing headless harness; file I/O is tested with the mocked File
System Access API already used in prior smoke tests.

---

- [ ] 1. Pure core: front-matter + identity + assembly (no UI, no I/O)
  - [ ] 1.1 Implement pen-name helpers: `penSlug(name)` sanitizer; load/save
    `voice-notes:penName`. Unit-test slugging and persistence round-trip.
    _Reqs: 1_
  - [ ] 1.2 Implement `parsePost(text)` and `serializePost(post)` for YAML
    front-matter + markdown body. Tolerate malformed/partial files (return null to
    skip). Round-trip tests + malformed-input test.
    _Reqs: 2.1, 2.2, 6 (partial-file tolerance)_
  - [ ] 1.3 Implement `assemble(posts)` (sort by `order`, then `created`, then `id`;
    concatenate bodies) and `nextOrder()` default. Unit-test determinism and
    tiebreak with equal `order` values.
    _Reqs: 4.1, 4.2, 4.5_
  - [ ] 1.4 Implement `postFileName(post)` and `mediaFileName(penSlug, id, name)`
    with id-based uniqueness. Unit-test collision-freeness for same pen name /
    equal order.
    _Reqs: 1.6, 2.1, 5.2_

- [ ] 2. Collab storage layer over the shared folder (reuse FS Access API)
  - [ ] 2.1 Add a parallel `collabState` and story-folder connect/disconnect
    reusing the existing directory-picker + IndexedDB handle persistence. Keep it
    separate from private-notes sync.
    _Reqs: 3.1, 8.2, 8.3_
  - [ ] 2.2 Implement `scanStory()`: read `posts/*.md`, parse, mark `mine` via pen
    slug, upsert map, drop vanished files, trigger re-render. Mock-FS test for
    multi-author scan and for a disappearing file.
    _Reqs: 3.4, 3.5, 2.6_
  - [ ] 2.3 Implement `writeOwnPost(post)` reusing external-change detection,
    `.bak` on conflict, and rename-cleanup. Mock-FS tests: normal write, external
    change → conflict (no clobber), reorder → old file removed.
    _Reqs: 2.5, 6.1, 6.2, 4.4_
  - [ ] 2.4 Enforce single-writer: refuse to write/delete files whose author slug
    != pen slug. Test that others' posts are read-only.
    _Reqs: 2.6, 3.3, 6.3_

- [ ] 3. Media attachments
  - [ ] 3.1 Implement add-media: write file to `media/` with owner-scoped name,
    insert a relative `![alt](media/..)` reference into the post body. Mock-FS test
    for write + reference insertion.
    _Reqs: 5.1, 5.2, 5.3_
  - [ ] 3.2 Enforce owner-only media writes/deletes; add a size-threshold warning.
    Test ownership guard and warning trigger.
    _Reqs: 5.4, 5.6_

- [ ] 4. Collaboration UI (opt-in mode)
  - [ ] 4.1 Add an explicit Private ↔ Collaboration mode switch; private notes
    remain the default and are untouched. Pen-name prompt/settings field.
    _Reqs: 1.1, 1.3, 8.1, 8.2, 8.4_
  - [ ] 4.2 Post list view: all posts with author attribution; own posts
    editable/deletable/reorderable, others read-only. Reuse conflict badges for own
    posts.
    _Reqs: 2.5, 2.6, 4.4, 6.2_
  - [ ] 4.3 Post editor: create/edit a post via typing and via existing voice
    transcription (Live + stop, with non-speech filtering).
    _Reqs: 2.3, 2.4_
  - [ ] 4.4 Assembled view: read-only rendered markdown of `assemble(posts)`,
    refreshed on scan.
    _Reqs: 4.3_

- [ ] 5. Export
  - [ ] 5.1 Export assembled document as a single `.md` with valid relative media
    paths. Optionally write `story.md` into the folder as regenerated output (never
    read back as source).
    _Reqs: 7.1, 7.2, 7.3, 5.5_

- [ ] 6. Integration, coexistence & docs
  - [ ] 6.1 End-to-end mock-FS test: two simulated authors write posts into one
    folder; verify both apps assemble an identical, correctly-ordered document and
    neither clobbers the other.
    _Reqs: 3.2, 4.5, (collision-freeness)_
  - [ ] 6.2 Verify switching modes never corrupts private notes; private-notes
    regression pass.
    _Reqs: 8.1, 8.4_
  - [ ] 6.3 Graceful degradation on non-Chromium (collab unavailable, private notes
    still work). Bump service worker cache version (shell assets changed). Update
    README with the collaboration workflow and the trust-model limitation.
    _Reqs: 3.1 (degradation), 8.1_

---

## Notes for implementation

- Do tasks in order; each should leave the app working and private notes intact.
- Prefer pure functions (task group 1) first so the risky logic is fully unit-tested
  before any UI or I/O is wired.
- Reuse, don't duplicate: external-change detection, `.bak`, rename-cleanup, handle
  persistence, and transcription already exist — wire into them.
- Per steering: bump `sw.js` cache version whenever shell assets change.
- Trust model is app-enforced ownership, not security (documented limitation).
