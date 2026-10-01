# Voice Notes — Offline Whisper

A free, offline Progressive Web App (PWA) for capturing ideas by voice. Audio is
transcribed **locally in the browser** with OpenAI's Whisper (via Transformers.js),
so after the first load there is no internet, no server, and no cost.

- Record your voice, get text appended to an editable document
- Two modes: transcribe once on Stop, or **Live** (text appears as you speak)
- Pick which microphone to use from an in-app dropdown
- Edit and type by hand too
- Keep multiple notes, selectable from a sidebar (create, rename, delete)
- Search/filter notes and drag to reorder them
- Optional folder sync: mirror notes to `.txt` files (e.g. in Google Drive), with
  protection against overwriting edits made outside the app
- Auto-saves to the browser; export the current note any time as `.txt`
- Keyboard shortcuts for new note, search, export, sidebar, and recording
- Installs to the Chromebook shelf and runs offline

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell and UI |
| `styles.css` | Styling (dark theme) |
| `app.js` | Recording, local Whisper transcription, save/export |
| `manifest.json` | PWA metadata (install) |
| `sw.js` | Service worker (offline caching) |
| `icons/` | App icons |

## Run it

PWAs must be served over HTTP (not opened as a `file://` path), and the
microphone requires a secure context (`http://localhost` counts as secure).

### On any machine with Node

```sh
npx http-server -p 8123 -c-1
```

Then open <http://localhost:8123>.

Any static server works (for example `python -m http.server 8123` if you have Python).

### On the Chromebook

1. Host the folder somewhere the Chromebook can reach over HTTPS, or run a static
   server on the Chromebook itself (e.g. a terminal app, or the Web Server for
   Chrome extension) and open it via `http://localhost:<port>`.
2. In Chrome, open the app URL.
3. Click **Record**, allow microphone access, speak, then click **Stop**.
   - The first recording downloads the Whisper model once (~40-150 MB depending
     on the selected model). This is cached for later offline use.
4. To install to the shelf: Chrome menu → **Install Voice Notes** (or the install
   icon in the address bar).

After the first successful online run, the app and model are cached, so it works
with no internet.

## Deploying to GitHub Pages

This app is static (no build step), so it hosts directly on GitHub Pages, which
serves over HTTPS — satisfying the secure-context requirement for the microphone,
File System Access API, and service worker.

1. Push the repo to GitHub.
2. In the repo: **Settings → Pages → Build and deployment**. Set
   **Source = Deploy from a branch**, choose your branch (e.g. `main`) and the
   `/ (root)` folder, then save. No GitHub Actions workflow is needed — the branch
   deploy mode publishes the files as-is.
3. After a minute it's live at `https://<user>.github.io/<repo>/`
   (for this repo: `https://vinvega.github.io/whisper/`).

Notes:

- All paths in the app are **relative**, so it works correctly from the `/<repo>/`
  subpath (no root-anchored URLs to fix).
- `.nojekyll` is included so GitHub serves files as-is (Jekyll would otherwise
  ignore files/folders beginning with an underscore).
- The site is **public**. There are no secrets in the code (all processing is
  client-side), and each visitor's notes live only in their own browser.
- After deploying an update, bump the cache version in `sw.js` (e.g.
  `voice-notes-shell-v2` → `v3`) so returning visitors get the new files instead of
  the service worker's cached copy.
- First load needs internet to fetch the Whisper model + Transformers.js from the
  CDN; afterward it's cached for offline use.

## Choosing a model

Use the dropdown in the header:

- **tiny.en** — fastest, lowest accuracy. Best for older/slower Chromebooks.
- **base.en** — balanced (default).
- **small.en** — most accurate, slowest and largest download.

If transcription feels slow on your Chromebook, switch to `tiny.en`.

## Transcription modes

Use the **Live** toggle in the header to choose how transcription happens:

- **Live off (default):** you record, then transcription runs once when you click
  **Stop**. This transcribes the whole recording in one pass with full context, so
  it's the **most accurate** option and uses the least CPU.
- **Live on:** text appears as you speak, appended as you go.

How Live works:

- Whisper isn't a true word-by-word streaming model. Live processes **overlapping
  windows** of recent audio: each pass transcribes the newest few seconds plus a
  short lead-in of already-committed audio for context, then **appends only the new
  words** (it stitches away the overlap). Earlier text is never rewritten.
- The lead-in overlap preserves most of the local context Whisper uses to
  disambiguate words, while keeping each pass small and roughly constant-time — so
  it won't bog down or lock up as the session grows.
- Only one pass runs at a time; if your device can't keep up, passes are skipped
  rather than queued.
- Non-speech noise that Whisper annotates — `(keyboard clicking)`, `[BLANK_AUDIO]`,
  `(typing)`, music notes — is filtered out automatically (in both modes).
- Turning Live on switches the model to **`tiny.en`** for responsiveness. You can
  change it back, but heavier models may lag in Live on modest hardware.

Accuracy tradeoff: Live never sees the full arc of what you said, so it's slightly
less accurate than **Live off**, which transcribes the complete recording at once.
Use Live to watch ideas appear as you talk; use Live off when accuracy matters most.

Tip: avoid typing in the editor during a live session — new text is appended at the
end as windows are processed. Edit freely once you've stopped.

## Choosing a microphone

Use the microphone dropdown in the header to pick which input device to record
from. "Default microphone" uses whatever your OS/browser has selected.

- Device names only appear after you've granted mic permission once; before that
  they show as generic names. The list refreshes automatically after the first
  recording and when you plug/unplug a device.
- Your choice is remembered. If the selected mic is later unavailable (e.g.
  unplugged), the app falls back to the default rather than failing.

## Notes & limits

- Models are English-only (`.en`). To support other languages, switch the model
  IDs in `app.js` to the multilingual variants (e.g. `Xenova/whisper-base`).
- By default notes are saved in the browser's local storage for this site;
  clearing site data will remove them, so export (or use folder sync) for anything
  important. You can also sync notes to a real folder — see **Folder sync** below.

## Working with multiple notes

- Open the sidebar with the menu button (top left). On narrow screens it slides
  over the editor; on wider screens it sits alongside.
- **+ New** (sidebar) or **New** (header) creates a fresh note.
- Click a note in the list to open it. New notes appear at the top; existing
  notes stay where you put them (see Reorder below).
- Rename a note by editing the title field above the editor. If you leave the title
  blank, it's derived automatically from the note's first line.
- Hover a note in the list and click **×** to delete it.
- The active note is remembered, so reopening the app returns you to it.
- **Search:** type in the search box to filter notes by title or content.
- **Reorder:** grab the handle (⠿) on the left of a note and drag it up or down.
  The order you set is saved. Editing a note no longer changes its position, so
  your manual order sticks. (Reordering is disabled while a search is active.)

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + N` | New note |
| `Ctrl/Cmd + F` | Focus the search box (opens the sidebar if collapsed) |
| `Ctrl/Cmd + S` | Export the current note as `.txt` |
| `Ctrl/Cmd + B` | Show/hide the sidebar |
| `Space` | Start/stop recording — only when you're not typing in the editor, title, or search box |

## Folder sync (save notes as files, e.g. to Google Drive)

The app can mirror your notes to plain `.txt` files in a folder you choose. On a
Chromebook, point it at a folder inside your **Google Drive** mount (via the Files
app) and ChromeOS/Drive handles syncing those files across your devices — no
accounts, API keys, or servers needed here.

This uses the browser's **File System Access API** (Chrome/Chromium, including
ChromeOS; needs `http://localhost` or HTTPS).

### How it works

- Click **Connect folder** at the bottom of the sidebar and pick a folder. The app
  writes each note to `<title>__<id>.txt` and keeps it updated as you edit.
- The browser's local storage stays the **source of truth**; the folder is a
  mirror. The app keeps working if the folder isn't connected.
- The chosen folder is remembered between sessions, though the browser may ask you
  to re-grant access with one click.
- **Disconnect** stops syncing; your notes stay in the app.

### Protection against overwriting external edits

The main risk with syncing is the app silently clobbering a change you made to a
file elsewhere (e.g. edited in Drive on your phone). The app guards against this:

- Before overwriting a file, it checks whether the file changed outside the app
  (by comparing the file's modified time and size against what it last wrote).
- If it changed, the app **does not overwrite**. It marks that note
  **"⚠ Changed in folder"** in the sidebar and lets you choose:
  - **Keep mine** — writes the app's version, but first copies the folder's
    current content to a `*.bak-<timestamp>.txt` file so the external version is
    never lost.
  - **Load from folder** — pulls the folder file's content into the app.
- **Read external edits** (opt-in toggle): when on, the app also periodically scans
  the folder and raises the same badge if a file changed, so you can pull in edits
  made elsewhere on your terms.

Nothing is overwritten in either direction without you choosing it, and resolved
conflicts always leave a recoverable `.bak` copy.

### Limitations

- Conflict handling detects *that* a file changed, not *what* changed, and does not
  auto-merge. If you edited both the app and the file, you pick one (both are kept
  — the other side is preserved as a `.bak`).
- One note maps to one file. Renaming a note writes the file under the new name and
  removes the old one automatically (the stable id in the filename makes this safe).

## Ideas for future improvement

Rough notes for where this could go next, roughly easiest to hardest:

- **Keyboard shortcuts:** focus search, start/stop recording, new note.
- **Import `.txt` files** from the connected folder as new notes (bulk read-in).
- **IndexedDB as the primary store** (instead of localStorage) to lift the ~5MB
  cap and store audio/attachments.
- **Richer conflict view:** show a side-by-side diff of the app vs. folder version
  before choosing Keep mine / Load from folder.
- **Silence-based live chunking:** Live currently advances on a fixed interval with
  overlapping windows. Splitting on natural pauses (silence detection via the Web
  Audio API) could give cleaner phrase boundaries and avoid cutting mid-word.
- **Two-way sync with real merge:** currently conflicts are last-writer-wins with a
  `.bak` safety net. A proper merge (or version history) would be the big step.
  Options considered and deferred: an in-browser `git` (isomorphic-git) — rejected
  because a live `.git` folder synced through Drive risks repo corruption and adds
  heavy complexity; or a small backend owning a real git repo + remote — rejected
  for now because it reintroduces a server, auth, and network, breaking the
  offline-first, zero-setup goal. Revisit only if versioned multi-device merge
  becomes a primary requirement.
- **Full Google Drive API integration:** reach notes on devices where Drive isn't
  mounted locally, using the Drive app-data folder. Needs OAuth + a Google Cloud
  project, so it trades away the current zero-setup simplicity.
