// Collaborative story — pure core logic (no DOM, no file I/O).
//
// This module is deliberately side-effect-free so it can be unit-tested in Node
// and reused by the browser app. It covers:
//   - pen-name identity (slug + storage key)
//   - post front-matter parse/serialize (YAML-ish subset + markdown body)
//   - deterministic assembly of posts into one document
//   - collision-free filename construction for posts and media
//
// Front-matter is intentionally a small, fixed-shape subset (not full YAML): a
// block of `key: value` lines between leading `---` fences. Values are strings,
// numbers, or ISO timestamps — no nested structures — which keeps parsing robust
// and dependency-free.

// ---------------------------------------------------------------------------
// Identity: pen name
// ---------------------------------------------------------------------------
export const PEN_NAME_KEY = "voice-notes:penName";

// Reduce a display pen name to a filename-safe slug: lowercase, non-alphanumerics
// collapsed to single hyphens, trimmed. Falls back to "anon" if nothing remains.
export function penSlug(name) {
  const slug = (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "anon";
}

// ---------------------------------------------------------------------------
// IDs & ordering
// ---------------------------------------------------------------------------
// Unique-ish post id: base36 timestamp + random suffix. Collision-resistant for a
// personal/small-group tool; combined with the author slug in filenames.
export function newPostId() {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
  );
}

// Default order key for a new post: creation time in epoch ms, so posts naturally
// append in chronological order unless explicitly reordered.
export function nextOrder(now = Date.now()) {
  return now;
}

// ---------------------------------------------------------------------------
// Front-matter parse / serialize
// ---------------------------------------------------------------------------
// A post object: { id, author, created, order, updated, body }
// On disk:
//   ---
//   id: ...
//   author: ...
//   created: ISO
//   order: number
//   updated: ISO
//   ---
//   <markdown body>

const FM_FENCE = "---";

// Serialize a post to its on-disk string. `author` (display pen name) is written
// verbatim. Numbers are written bare; everything else as-is on one line.
export function serializePost(post) {
  const fm = {
    id: post.id,
    author: post.author,
    created: post.created,
    order: post.order,
    updated: post.updated || post.created,
  };
  const lines = [FM_FENCE];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${serializeValue(v)}`);
  }
  lines.push(FM_FENCE);
  const body = post.body == null ? "" : String(post.body);
  // One blank line between front-matter and body for readability.
  return lines.join("\n") + "\n" + body;
}

function serializeValue(v) {
  if (typeof v === "number") return String(v);
  // Keep it on one line; collapse accidental newlines in scalar fields.
  return String(v == null ? "" : v).replace(/\r?\n/g, " ");
}

// Parse an on-disk post string. Returns a post object, or null if the input is not
// a well-formed post (missing fences or required fields) — callers skip nulls so a
// partially-synced/corrupt file never breaks a scan.
export function parsePost(text) {
  if (typeof text !== "string") return null;
  const trimmedStart = text.replace(/^\uFEFF/, ""); // tolerate BOM

  if (!trimmedStart.startsWith(FM_FENCE)) return null;

  // Find the closing fence on its own line.
  const rest = trimmedStart.slice(FM_FENCE.length);
  const closeMatch = rest.match(/\r?\n---[ \t]*(\r?\n|$)/);
  if (!closeMatch) return null;

  const fmBlock = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length);

  const fm = {};
  for (const rawLine of fmBlock.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) fm[key] = val;
  }

  // Required fields.
  if (!fm.id || !fm.author) return null;

  const order = Number(fm.order);
  const post = {
    id: fm.id,
    author: fm.author,
    created: fm.created || "",
    order: Number.isFinite(order) ? order : 0,
    updated: fm.updated || fm.created || "",
    body: body.replace(/^\n/, ""), // drop the single separator newline
  };
  return post;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------
// Deterministic order: by `order` asc, then `created` asc, then `id` asc. The
// tiebreak guarantees every collaborator computes the identical sequence even when
// two posts share an `order` value.
export function sortPosts(posts) {
  return [...posts].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.created !== b.created) return a.created < b.created ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

// Assemble posts into one markdown document. Bodies are joined with a blank line.
export function assemble(posts) {
  return sortPosts(posts)
    .map((p) => (p.body == null ? "" : String(p.body).trim()))
    .filter((b) => b.length > 0)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Filenames (collision-free)
// ---------------------------------------------------------------------------
// Post filename: <paddedOrder>__<penSlug>__<id>.md
// - padded order makes a raw directory sort approximate reading order
// - penSlug + id guarantee uniqueness even if two authors share a pen name or order
const ORDER_PAD = 16; // enough for epoch-ms far into the future

function padOrder(order) {
  const n = Math.max(0, Math.floor(Number(order) || 0));
  return String(n).padStart(ORDER_PAD, "0");
}

export function postFileName(post) {
  return `${padOrder(post.order)}__${penSlug(post.author)}__${post.id}.md`;
}

// Does a filename belong to the given pen slug? Used for ownership checks.
export function isOwnedBy(fileName, slug) {
  // Match the middle segment between the two "__" separators.
  const m = /^\d+__([^_]+(?:_[^_]+)*)__[^_]+\.md$/.exec(fileName);
  if (!m) return false;
  return m[1] === slug;
}

// Media filename: <penSlug>__<id>__<safeOriginalName>
// Owner-scoped so media never collides across authors.
export function mediaFileName(slug, id, originalName) {
  const safe = safeMediaName(originalName);
  return `${slug}__${id}__${safe}`;
}

function safeMediaName(name) {
  const n = (name || "file").trim();
  const dot = n.lastIndexOf(".");
  const base = (dot > 0 ? n.slice(0, dot) : n)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "file";
  const ext = (dot > 0 ? n.slice(dot + 1) : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 8);
  return ext ? `${base}.${ext}` : base;
}
