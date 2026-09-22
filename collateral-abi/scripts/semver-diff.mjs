// Computes the required semver bump by diffing the ABI surface of the
// last-published package against the freshly built one.
//
//   Usage: node scripts/semver-diff.mjs <publishedPkgRoot> <currentPkgRoot> [ownedEnv]
//   Prints one of: major | minor | patch | none
//
// ownedEnv ("testnet" or "mainnet") limits the deployments.json
// comparison to that environment, so copying the other network forward
// does not count as a change.
//
// Rules — the ABI *is* the public API, so the level is computable:
//   - ABI entry removed or modified, or a contract file removed  -> major
//   - New ABI entry or new contract file                         -> minor
//   - Only the owned environment or README changed               -> patch
//   - Nothing changed                                            -> none
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const [publishedRoot, currentRoot, ownedEnv] = process.argv.slice(2);
if (!publishedRoot || !currentRoot) {
  console.error("Usage: semver-diff.mjs <publishedPkgRoot> <currentPkgRoot> [ownedEnv]");
  process.exit(1);
}

function canonDeploy(value) {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return `[${value.map(canonDeploy).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonDeploy(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

// Only ABI files (JSON arrays) count toward the diff; stray manifests like a
// codegen-emitted package.json are ignored on both sides.
const isAbiFile = (dir, f) => {
  try {
    return Array.isArray(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  } catch {
    return false;
  }
};
const listJson = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && isAbiFile(dir, f)).sort() : [];

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
  const readmeChanged = ["README.md"].some((file) => {
    const oldPath = path.join(publishedRoot, file);
    const newPath = path.join(currentRoot, file);
    if (!existsSync(oldPath) || !existsSync(newPath)) return true;
    return readFileSync(oldPath, "utf8") !== readFileSync(newPath, "utf8");
  });
  const oldDoc = JSON.parse(readFileSync(path.join(publishedRoot, "deployments.json"), "utf8"));
  const newDoc = JSON.parse(readFileSync(path.join(currentRoot, "deployments.json"), "utf8"));
  const oldSlice = ownedEnv ? oldDoc.environments?.[ownedEnv] : oldDoc;
  const newSlice = ownedEnv ? newDoc.environments?.[ownedEnv] : newDoc;
  const deploymentsChanged = canonDeploy(oldSlice) !== canonDeploy(newSlice);
  console.log(deploymentsChanged || readmeChanged ? "patch" : "none");
}
