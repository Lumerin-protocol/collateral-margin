// Computes the required semver bump by diffing the ABI surface of the
// last-published package against the freshly built one.
//
//   Usage: node scripts/semver-diff.mjs <publishedPkgRoot> <currentPkgRoot>
//   Prints one of: major | minor | patch | none
//
// Rules — the ABI *is* the public API, so the level is computable:
//   - ABI entry removed or modified, or a contract file removed  -> major
//   - New ABI entry or new contract file                         -> minor
//   - Only metadata changed (deployments.json, README, ...)      -> patch
//   - Nothing changed                                            -> none
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const [publishedRoot, currentRoot] = process.argv.slice(2);
if (!publishedRoot || !currentRoot) {
  console.error("Usage: semver-diff.mjs <publishedPkgRoot> <currentPkgRoot>");
  process.exit(1);
}

// Canonical stringify (sorted keys) so formatting differences don't matter
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const abiEntries = (file) => new Set(JSON.parse(readFileSync(file, "utf8")).map(canon));
const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);

const oldDir = path.join(publishedRoot, "json");
const newDir = path.join(currentRoot, "json");
const oldFiles = listJson(oldDir);
const newFiles = listJson(newDir);

let removedOrChanged = false;
let added = false;

for (const file of oldFiles) {
  if (!newFiles.includes(file)) {
    removedOrChanged = true;
    continue;
  }
  const oldSet = abiEntries(path.join(oldDir, file));
  const newSet = abiEntries(path.join(newDir, file));
  for (const entry of oldSet) if (!newSet.has(entry)) removedOrChanged = true;
  for (const entry of newSet) if (!oldSet.has(entry)) added = true;
}
for (const file of newFiles) {
  if (!oldFiles.includes(file)) added = true;
}

if (removedOrChanged) {
  console.log("major");
} else if (added) {
  console.log("minor");
} else {
  // ABI surface identical — check whether package metadata changed
  const metaChanged = ["deployments.json", "README.md"].some((file) => {
    const oldPath = path.join(publishedRoot, file);
    const newPath = path.join(currentRoot, file);
    if (!existsSync(oldPath) || !existsSync(newPath)) return true;
    return readFileSync(oldPath, "utf8") !== readFileSync(newPath, "utf8");
  });
  console.log(metaChanged ? "patch" : "none");
}
