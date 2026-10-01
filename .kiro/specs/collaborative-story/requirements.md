# Requirements — Collaborative Story Writing

## Overview

Extend Voice Notes to support collaboratively writing a shared document (e.g. a
story) with another person, using a shared folder (such as a Google Drive folder
synced via the existing File System Access API integration).

The core design principle is **one markdown file per post, with a single writer per
file**. Each contributor only ever creates, edits, or deletes their *own* posts.
The combined document is a **derived view**, assembled by reading all post files and
ordering them. Because no two people ever write the same file, concurrent
contributions never collide, and no text-level merge/CRDT machinery is required.

This feature is **additive** and must not break the existing private single-user
notes experience.

## Terminology

- **Pen name** — a persistent author identity the user sets once. It identifies
  authorship and enforces single-writer ownership of posts.
- **Post** — one authored unit of the story, stored as a single markdown file with
  front-matter. The atomic unit of ownership.
- **Story (collection)** — a shared folder containing many posts (from multiple
  authors) plus optional media, which assemble into one document.
- **Assembled document** — the derived, read-only concatenation of all posts in
  order. Regenerated on demand; never the source of truth.

---

## Requirement 1: Persistent pen name

**User story:** As a contributor, I want to set a persistent pen name, so that my
contributions are attributed to me and the app knows which posts are mine to edit.

### Acceptance criteria

1. WHEN the user opens the collaboration feature for the first time THEN the system
   SHALL prompt for a pen name before allowing them to author posts.
2. The system SHALL persist the pen name locally and reuse it across sessions
   without re-prompting.
3. The user SHALL be able to change their pen name via a settings control.
4. The system SHALL store the pen name in each post's front-matter and incorporate
   it into each post's filename.
5. The pen name SHALL be sanitized to a filename-safe slug for use in filenames,
   while the original (display) pen name is preserved in front-matter.
6. IF two users happen to choose the same pen name THEN the system SHALL still avoid
   file collisions by including a unique per-post id in the filename (pen name alone
   is not relied upon for uniqueness).

---

## Requirement 2: Post authoring (markdown)

**User story:** As a contributor, I want each of my contributions stored as its own
markdown post, so that I can write independently without colliding with my
co-author.

### Acceptance criteria

1. The system SHALL store each post as a single markdown file containing YAML
   front-matter followed by the markdown body.
2. The front-matter SHALL include at least: `id`, `author` (display pen name),
   `created` (ISO timestamp), and `order` (sort key).
3. WHEN the user creates a post THEN the system SHALL assign a unique `id` and an
   `order` value and write the file into the shared folder.
4. The user SHALL be able to dictate a post via voice (reusing existing
   transcription) and/or type it.
5. The system SHALL allow editing and deleting posts the user authored (where
   `author` matches the user's pen name).
6. The system SHALL NOT allow editing or deleting posts authored by someone else
   from within the app (read-only for others' posts).

---

## Requirement 3: Shared-folder storage & sync

**User story:** As a contributor, I want posts stored in a shared folder that syncs
between collaborators, so that we each see one another's contributions.

### Acceptance criteria

1. The system SHALL store posts in a user-chosen folder using the existing File
   System Access API integration (Chromium browsers; graceful degradation
   elsewhere).
2. WHEN pointed at a folder inside a shared Google Drive mount THEN the system SHALL
   rely on Drive to sync post files between collaborators (no Drive API / OAuth).
3. The system SHALL only write files it owns: the user's own posts and media. It
   SHALL NOT modify files authored by others.
4. The system SHALL periodically (and on demand) re-scan the folder to pick up new
   or changed posts from collaborators.
5. WHEN a collaborator adds a new post file THEN the system SHALL include it in the
   assembled document on the next scan.

---

## Requirement 4: Ordering & assembly

**User story:** As a contributor, I want all posts assembled into one coherent
document in a predictable order, so that the story reads correctly regardless of who
wrote what.

### Acceptance criteria

1. The system SHALL assemble the document by reading all post files and sorting them
   by the `order` front-matter value.
2. WHEN two posts have equal `order` values THEN the system SHALL break the tie
   deterministically (e.g. by `created` timestamp, then `id`) so all collaborators
   compute the same sequence.
3. The system SHALL display the assembled document as a read-only combined view.
4. The user SHALL be able to change the `order` of their *own* posts (reordering
   their contributions) without modifying any other author's files.
5. The assembly SHALL be deterministic: given the same set of post files, every
   collaborator produces identical ordering.

---

## Requirement 5: Media attachments

**User story:** As a contributor, I want to attach media (such as images) to the
story, so that the document can include more than text.

### Acceptance criteria

1. The system SHALL allow the user to add media files (at minimum images) to a post.
2. The system SHALL store media in a dedicated subfolder of the shared folder (e.g.
   `media/`), with filenames incorporating the author pen-name slug and a unique id
   to avoid collisions.
3. A post SHALL reference its media using standard markdown syntax (e.g.
   `![alt](media/<file>)`) so the assembled document and the raw files remain
   portable and viewable outside the app.
4. The system SHALL only write/delete media the user added; media added by others is
   read-only.
5. WHEN the assembled document is exported THEN media references SHALL remain valid
   relative paths within the shared folder.
6. The system SHOULD guard against excessively large media (surface a warning or
   size guidance) given browser storage/sync constraints.

---

## Requirement 6: External-change detection (safety)

**User story:** As a contributor, I want to be warned rather than silently
clobbered when a file changes outside the app, so that no contribution is lost.

### Acceptance criteria

1. The system SHALL reuse the existing external-change detection (modified
   time/size) before overwriting any file it owns.
2. IF one of the user's own post files changed externally since the app last wrote
   it THEN the system SHALL flag a conflict and NOT overwrite without an explicit
   user choice (Keep mine / Load from folder), preserving a `.bak` of the replaced
   content, consistent with existing behavior.
3. The system SHALL treat other authors' posts as read-only inputs; changes to them
   are picked up on scan and never cause a conflict prompt for this user.

---

## Requirement 7: Export

**User story:** As a contributor, I want to export the assembled story, so that I
can share or publish the finished document.

### Acceptance criteria

1. The system SHALL export the assembled document as a single markdown file.
2. The system SHOULD optionally write the assembled document to the shared folder
   (e.g. `story.md`) as a regenerated OUTPUT, never read back as a source of truth.
3. Exported media references SHALL remain valid relative to the exported document's
   location.

---

## Requirement 8: Coexistence with existing private notes

**User story:** As an existing user, I want my current private notes to keep working
unchanged, so that adding collaboration doesn't disrupt my personal use.

### Acceptance criteria

1. The existing private, single-user notes (localStorage-backed) SHALL continue to
   function with no behavioral change.
2. Collaboration mode SHALL be an explicit, opt-in mode distinct from private notes.
3. The existing per-note folder sync (private `.txt` mirroring) and the new
   collaborative post storage SHALL be clearly separated so the user understands
   which mode they are in.
4. Switching into or out of collaboration mode SHALL NOT delete or corrupt existing
   private notes.

---

## Non-goals (explicitly out of scope for this feature)

- **Live, in-place co-editing of the same post** (two cursors in one block). This is
  the CRDT/operational-transform problem and is deliberately avoided by the
  one-writer-per-file model.
- **Fine-grained merge** of concurrent edits to the same text.
- **Google Docs app integration** (live editing inside an actual Google Doc). This
  would require the Google Docs API + OAuth and is a separate, larger effort.
- **Real-time presence/cursors.** Sync is file-based via Drive, not a live channel.
