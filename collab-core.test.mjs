// Unit tests for collab-core.js (pure logic). Run: node collab-core.test.mjs
import {
  penSlug,
  newPostId,
  nextOrder,
  serializePost,
  parsePost,
  sortPosts,
  assemble,
  postFileName,
  isOwnedBy,
  mediaFileName,
} from "./collab-core.js";

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.log("FAIL:", msg);
    process.exit(1);
  }
  passed++;
  console.log("ok:", msg);
}
function eq(a, b, msg) {
  assert(a === b, `${msg} (got ${JSON.stringify(a)})`);
}

// --- 1.1 penSlug ---
eq(penSlug("Vin Vega"), "vin-vega", "spaces -> hyphen, lowercased");
eq(penSlug("  Édgar!!  "), "edgar", "diacritics stripped, punctuation collapsed, trimmed");
eq(penSlug("A_B.C"), "a-b-c", "underscores/dots -> hyphens");
eq(penSlug(""), "anon", "empty -> anon fallback");
eq(penSlug("***"), "anon", "all-symbols -> anon fallback");
eq(penSlug("coAuthor2"), "coauthor2", "alphanumerics preserved");

// --- ids/order ---
assert(newPostId() !== newPostId(), "newPostId yields distinct ids");
eq(typeof nextOrder(123), "number", "nextOrder returns a number");
eq(nextOrder(1696170600000), 1696170600000, "nextOrder defaults to given time");

// --- 1.2 serialize/parse round-trip ---
const post = {
  id: "abc-123",
  author: "Vin Vega",
  created: "2026-10-01T14:30:00.000Z",
  order: 1696170600000,
  updated: "2026-10-01T14:31:00.000Z",
  body: "The lighthouse had not blinked in thirty years.\n\nUntil tonight.",
};
const text = serializePost(post);
assert(text.startsWith("---\n"), "serialized starts with front-matter fence");
const parsed = parsePost(text);
eq(parsed.id, post.id, "round-trip id");
eq(parsed.author, post.author, "round-trip author (verbatim display name)");
eq(parsed.created, post.created, "round-trip created");
eq(parsed.order, post.order, "round-trip order as number");
eq(parsed.updated, post.updated, "round-trip updated");
eq(parsed.body, post.body, "round-trip body preserved exactly");

// updated defaults to created when absent
const t2 = serializePost({ id: "x", author: "A", created: "2026-01-01T00:00:00Z", order: 1, body: "hi" });
eq(parsePost(t2).updated, "2026-01-01T00:00:00Z", "updated defaults to created");

// --- 1.2 malformed inputs -> null (skipped by callers) ---
eq(parsePost("no front matter here"), null, "missing fences -> null");
eq(parsePost("---\nid: x\nauthor: A\n"), null, "unterminated front-matter -> null");
eq(parsePost("---\nauthor: A\n---\nbody"), null, "missing required id -> null");
eq(parsePost("---\nid: x\n---\nbody"), null, "missing required author -> null");
eq(parsePost(""), null, "empty string -> null");
eq(parsePost(null), null, "non-string -> null");
// BOM tolerated
assert(parsePost("\uFEFF---\nid: x\nauthor: A\n---\nhi") !== null, "BOM tolerated");

// order defaults to 0 when non-numeric
eq(parsePost("---\nid: x\nauthor: A\norder: notnum\n---\nb").order, 0, "non-numeric order -> 0");

// --- 1.3 assemble determinism + tiebreak ---
const p = (id, order, created, body) => ({ id, order, created, author: "A", body });
const unsorted = [
  p("c", 20, "2026-01-01T00:00:02Z", "third"),
  p("a", 10, "2026-01-01T00:00:00Z", "first"),
  p("b", 10, "2026-01-01T00:00:01Z", "second"),
];
eq(assemble(unsorted), "first\n\nsecond\n\nthird", "assembled in order, tiebreak by created");

// equal order AND equal created -> tiebreak by id
const tie = [p("zed", 5, "t", "Z"), p("alpha", 5, "t", "A")];
eq(assemble(tie), "A\n\nZ", "equal order+created tiebreak by id asc");

// deterministic regardless of input order
const shuffled = [unsorted[2], unsorted[0], unsorted[1]];
eq(assemble(shuffled), assemble(unsorted), "assembly independent of input order");

// empty bodies skipped
eq(assemble([p("a", 1, "t", "  "), p("b", 2, "t", "kept")]), "kept", "blank bodies dropped");

// sortPosts does not mutate input
const orig = [p("b", 2, "t", "x"), p("a", 1, "t", "y")];
const copy = [...orig];
sortPosts(orig);
eq(orig[0].id, copy[0].id, "sortPosts does not mutate the input array");

// --- 1.4 filenames ---
const fnA = postFileName({ id: "id1", author: "Vin Vega", order: 1696170600000 });
const fnB = postFileName({ id: "id2", author: "Vin Vega", order: 1696170600000 });
assert(fnA !== fnB, "same author + same order still produce distinct filenames (id)");
assert(fnA.endsWith("__vin-vega__id1.md"), "post filename shape: slug + id");
assert(/^0+1696170600000__/.test(fnA), "order is zero-padded for sortability");

// same pen name, different authors conceptually -> ids differ -> no collision
const sameNameOther = postFileName({ id: "id3", author: "VIN VEGA", order: 5 });
assert(sameNameOther.includes("__vin-vega__id3.md"), "case-insensitive slug, unique by id");

// ownership check
assert(isOwnedBy(fnA, "vin-vega"), "isOwnedBy true for matching slug");
assert(!isOwnedBy(fnA, "coauthor"), "isOwnedBy false for different slug");
assert(isOwnedBy(postFileName({ id: "i", author: "co author", order: 1 }), "co-author"),
  "isOwnedBy handles multi-part slugs");

// media filename
const m = mediaFileName("vin-vega", "mid1", "My Photo.PNG");
eq(m, "vin-vega__mid1__my-photo.png", "media filename owner-scoped + safe name + ext");
const m2 = mediaFileName("vin-vega", "mid2", "no-extension");
eq(m2, "vin-vega__mid2__no-extension", "media filename without extension");
assert(mediaFileName("a", "1", "x.png") !== mediaFileName("a", "2", "x.png"),
  "same source name, different id -> distinct media filenames");

console.log(`\nALL ${passed} COLLAB-CORE TESTS PASSED`);
