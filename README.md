# Voice Notes — Offline Whisper

A free, offline Progressive Web App (PWA) for capturing ideas by voice. Audio is
transcribed **locally in the browser** with OpenAI's Whisper (via Transformers.js),
so after the first load there is no internet, no server, and no cost.

- Record your voice, get text appended to an editable document
- Edit and type by hand too
- Auto-saves to the browser; export any time as `.txt`
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

## Notes & limits

- Transcription runs after you press **Stop** (record a chunk, then transcribe),
  not live word-by-word. This keeps it reliable on modest hardware.
- Models are English-only (`.en`). To support other languages, switch the model
  IDs in `app.js` to the multilingual variants (e.g. `Xenova/whisper-base`).
- Everything stays on the device. Notes are saved in the browser's local storage
  for this site; clearing site data will remove them, so export anything important.
