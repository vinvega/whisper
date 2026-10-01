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
7. The system SHALL keep ALL posts (the user's own and co-authors') visible in the
   post list while the user is editing a post, so the user retains the context of
   the whole story. Only one of the user's own posts is edited at a time; the list
   remains alongside the editor.

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
4. The system SHALL re-scan the folder to pick up new or changed posts from
   collaborators (see Requirement 3a for exactly how/when).
5. WHEN a collaborator adds a new post file THEN the system SHALL include it in the
   view the next time changes are applied (manual refresh, or an automatic apply
   when safe — see Requirement 3a).

---

## Requirement 3a: Refresh model (manual + notify-only background check)

**User story:** As a contributor, I want control over when co-authors' changes
appear in my view, so that new content never reshuffles the list while I'm in the
middle of writing, but I'm still told when there's something new.

### Acceptance criteria

1. The system SHALL provide a **manual Refresh** control that, when invoked, scans
   the shared folder and applies all detected changes (new/edited/removed posts and
   media) to the view.
2. The system SHALL run a **quiet background check** on an interval that detects
   whether the folder has changed, WITHOUT automatically reshuffling or replacing
   what the user is currently viewing/editing.
3. WHEN the background check detects changes THEN the system SHALL show an
   unobtrusive indicator (e.g. "N new updates — Refresh") rather than applying them
   immediately.
4. The system SHALL NOT alter the content of the post the user is actively editing
   as a result of a background check. The user's in-progress text is never replaced
   without an explicit action.
5. WHEN the user is NOT actively editing (e.g. viewing the assembled document) THEN
   the system MAY apply detected changes automatically, OR surface the same
   indicator; it SHALL NOT, in any case, discard unsaved edits.
6. Clicking the indicator SHALL perform the same operation as the manual Refresh
   control.
7. The background check interval SHALL be chosen to be light on the folder (polling,
   since the File System Access API provides no change notifications) and SHALL be
   pausable/absent without breaking manual refresh.

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

## Requirement 5a: Insert picture (editor action)

**User story:** As a contributor editing a post, I want an "Insert picture" button
that lets me add a new image or reuse an existing one, and drops the correct
markdown at my cursor, so that embedding images is quick and I don't have to type
markdown or re-upload images that already exist.

### Acceptance criteria

1. The post editor SHALL provide an **Insert picture** action.
2. Invoking it SHALL offer two sources:
   1. **Upload new** — choose an image file from the device; the system stores it in
      `media/` (owner-scoped name per Req 5.2) and references it.
   2. **Choose existing** — pick from the story's existing media library.
3. The media library SHALL list media files already present in the shared folder,
   including those added by co-authors (so any image in the story can be referenced).
4. WHEN the user confirms a selection THEN the system SHALL insert a markdown image
   reference (`![alt](media/<file>)`) at the current cursor position in the post
   body, not merely append it.
5. IF the editor has no active caret (e.g. it was never focused) THEN the system
   SHALL insert at the end of the post body as a fallback.
6. The system SHALL let the user provide/edit the alt text for the inserted image
   (defaulting to the file's base name).
7. Referencing an existing image SHALL NOT duplicate the file in `media/`.
8. Deleting a media file SHALL remain owner-only (Req 5.4); referencing a
   co-author's image does not grant delete rights.

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

## Requirement 7: Build the combined story

**User story:** As a contributor, I want to build the combined story into a single
file in the shared folder, so that anyone can read the whole assembled document
outside the app (e.g. directly in Google Drive), and so it stays reasonably fresh
while we write.

### Acceptance criteria

1. The system SHALL provide an explicit **Build combined story** button that any
   user can press. Pressing it SHALL assemble the posts the user currently has
   synced (loaded in their app) and write the result to `story.md` in the shared
   folder.
2. The combined output SHALL reflect **what that user currently has synced** — i.e.
   their current loaded view — which depends on their last refresh. The UI SHALL
   make this scope clear (building reflects your current view; press Refresh first
   to include the latest from co-authors).
3. The system SHALL, after a period of user inactivity (default ~30 seconds idle),
   launch a background task that rebuilds `story.md` — but only IF the content has
   changed since the last build (skip identical rebuilds).
4. The idle timer SHALL reset on user activity (typing, editing, voice capture,
   navigation) so the rebuild only fires once the user has genuinely paused.
5. `story.md` SHALL be treated as **regenerated OUTPUT**, never read back as a source
   of truth. Editing `story.md` by hand is not supported (it will be overwritten).
6. Because `story.md` is fully derived and deterministic, it is EXEMPT from
   single-writer discipline and from the conflict/`.bak` protection: any user may
   overwrite it, and a concurrent rebuild by another user is an acceptable
   last-writer-wins overwrite (no data is lost, since posts are the source of truth).
7. Media references in `story.md` SHALL remain valid relative paths (e.g.
   `media/<file>`) within the shared folder.
8. The system SHALL also allow exporting/downloading the combined document locally
   (a `.md` download) in addition to writing `story.md` into the folder.
9. The background rebuild SHALL be lightweight and SHALL NOT interrupt editing,
   recording, or refresh operations.

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
