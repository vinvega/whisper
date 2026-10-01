// Coexistence + degradation checks for the collaboration feature.
//  - collab storage keys must not collide with private-notes localStorage keys
//  - collab-core/collab-store must not read or write private-notes keys
//  - the collab IndexedDB handle key differs from the private folder-sync key
import { PEN_NAME_KEY } from "./collab-core.js";

let passed = 0;
function assert(c, m) { if (!c) { console.log("FAIL:", m); process.exit(1); } passed++; console.log("ok:", m); }

// Private-notes keys used by app.js (must remain exclusively app.js's).
const PRIVATE_KEYS = [
  "voice-notes:index",
  "voice-notes:note:", // prefix
  "voice-notes:active",
  "voice-notes:model",
  "voice-notes:document",
  "voice-notes:mic",
  "voice-notes:live",
  "voice-notes:readExternal",
];

// Collab localStorage key (only one: the pen name).
assert(PEN_NAME_KEY === "voice-notes:penName", "collab pen-name key is voice-notes:penName");
assert(!PRIVATE_KEYS.includes(PEN_NAME_KEY), "pen-name key does not collide with any private-notes key");
assert(!PEN_NAME_KEY.startsWith("voice-notes:note:"), "pen-name key is not a note-body key");

// Static source scan: collab-core.js and collab-store.js must not touch private keys.
import { readFileSync } from "fs";
const core = readFileSync("./collab-core.js", "utf8");
const store = readFileSync("./collab-store.js", "utf8");
for (const k of ["voice-notes:index", "voice-notes:note:", "voice-notes:active", "voice-notes:document"]) {
  assert(!core.includes(k), `collab-core.js does not reference ${k}`);
  assert(!store.includes(k), `collab-store.js does not reference ${k}`);
}
// No actual localStorage ACCESS (ignore the word in comments) in the storage/core.
assert(!/localStorage\s*\./.test(core), "collab-core.js makes no localStorage calls");
assert(!/localStorage\s*\./.test(store), "collab-store.js makes no localStorage calls");

// collab.js uses a distinct IndexedDB handle key from app.js's folder sync.
const collab = readFileSync("./collab.js", "utf8");
assert(collab.includes("collabDirHandle"), "collab.js uses the collabDirHandle IndexedDB key");
assert(!collab.includes('"dirHandle"') && !collab.includes("'dirHandle'"),
  "collab.js does not reuse the private folder-sync handle key 'dirHandle'");

// Degradation: collab.js must feature-detect showDirectoryPicker.
assert(collab.includes("showDirectoryPicker"), "collab.js feature-detects showDirectoryPicker");
assert(/initCollab\s*\(\)/.test(collab), "collab.js guards init behind element presence (initCollab)");

console.log(`\nALL ${passed} COEXISTENCE/DEGRADATION CHECKS PASSED`);
