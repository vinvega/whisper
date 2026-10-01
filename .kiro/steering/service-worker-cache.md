# Service Worker Cache Versioning

When you change any file cached by the service worker, bump the cache version in
`sw.js` in the same change. Otherwise returning visitors (and the installed PWA)
keep serving the old files from the service worker's cache after deployment.

## When to bump

Bump the version whenever you modify any asset listed in `SHELL_ASSETS` in `sw.js`:

- `index.html`
- `styles.css`
- `app.js`
- `manifest.json`
- the files under `icons/`
- `sw.js` itself (if its logic changes)

If a change only touches non-cached files (e.g. `README.md`, `.kiro/`), no bump is
needed.

## How to bump

In `sw.js`, increment the version suffix on both cache name constants together:

```js
const SHELL_CACHE = "voice-notes-shell-v2";    // -> v3
const RUNTIME_CACHE = "voice-notes-runtime-v2"; // -> v3
```

Keep the two in sync (same version number). The `activate` handler already deletes
any cache whose name doesn't match the current constants, so bumping is enough to
clear stale caches on the next load.

## Verify

After bumping, a hard refresh (Ctrl+Shift+R) should fetch the new assets, and the
old `*-v<n-1>` caches should be gone (checkable in DevTools → Application → Cache
Storage).
