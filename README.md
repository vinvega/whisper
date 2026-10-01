# Voice Notes — Offline Whisper

A free, offline Progressive Web App (PWA) for capturing ideas by voice. Audio is
transcribed **locally in the browser** with OpenAI's Whisper (via Transformers.js),
so after the first load there is no internet, no server, and no cost.

- Record your voice, get text appended to an editable document
- Two modes: transcribe once on Stop, or **Live** (text appears as you speak)
- Edit and type by hand too
- Keep multiple notes, selectable from a sidebar (create, rename, delete)
- Search/filter notes and drag to reorder them
- Auto-saves to the browser; export the current note any time as `.txt`
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

## Choosing a model

Use the dropdown in the header:

- **tiny.en** — fastest, lowest accuracy. Best for older/slower Chromebooks.
- **base.en** — balanced (default).
- **small.en** — most accurate, slowest and largest download.

If transcription feels slow on your Chromebook, switch to `tiny.en`.

## Transcription modes

Use the **Live** toggle in the header to choose how transcription happens:

- **Live off (default):** you record, then transcription runs once when you click
  **Stop**. Most reliable, lowest CPU use, best accuracy per recording.
- **Live on:** text appears as you speak. The app re-transcribes the session
  every few seconds and updates the editor (near-real-time, chunked).

How Live works and its limits:

- Whisper isn't a true word-by-word streaming model, so Live re-transcribes the
  whole current session each pass. That keeps words from being clipped at chunk
  boundaries, at the cost of more CPU.
- Only one transcription runs at a time. If your Chromebook can't keep up, extra
  passes are skipped rather than queued, so it degrades gracefully.
- A single live session's audio is capped (about 90s is fed to the model) to stay
  responsive; the committed text is kept, so longer dictation still works.
- On modest hardware, use `tiny.en` with Live for the smoothest experience.
- Avoid typing in the editor during a live session — the next pass rewrites the
  in-progress text. Edit freely once you've stopped.

## Notes & limits

- Models are English-only (`.en`). To support other languages, switch the model
  IDs in `app.js` to the multilingual variants (e.g. `Xenova/whisper-base`).
- Everything stays on the device. Notes are saved in the browser's local storage
  for this site; clearing site data will remove them, so export anything important.

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
