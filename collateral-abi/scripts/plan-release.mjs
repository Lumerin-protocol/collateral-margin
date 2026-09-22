// Decide the version and npm dist-tag for this publish.
//
//   dev  -> dist-tag `dev`, bump minor for an ABI or testnet-manifest change.
//           The base is the `dev` tag, or the highest published 0.x if that
//           tag does not exist yet. Never moves `latest`.
//   main -> dist-tag `latest`. The first publish whose mainnet block has
//           addresses is 3.0.0, or the next free major if that version was
//           already published (npm will not reuse an unpublished version).
//           After that, an ABI break bumps major, an ABI addition bumps
//           minor, and a mainnet address change bumps patch.
//
// Writes package.json's version in the working copy (npm holds the version
// of record; nothing is committed). Set DRY_RUN=1 to print the decision only.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name;
const dryRun = process.env.DRY_RUN === "1";

function emit(fields) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function canonDeploy(value) {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return `[${value.map(canonDeploy).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonDeploy(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function npmJson(args) {
  return JSON.parse(execFileSync("npm", args, { encoding: "utf8" }));
}

function distTags() {
  try {
    return npmJson(["view", pkg, "dist-tags", "--json"]);
  } catch {
    return {};
  }
}

function versionsOf() {
  try {
    const parsed = npmJson(["view", pkg, "versions", "--json"]);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// `npm view versions` hides unpublished releases. `time` still lists them,
// and npm rejects a publish that reuses one of those version numbers.
function takenVersions() {
  try {
    const time = npmJson(["view", pkg, "time", "--json"]);
    return new Set(Object.keys(time).filter((key) => /^\d+\.\d+\.\d+$/.test(key)));
  } catch {
    return new Set(versionsOf());
  }
}

function firstMainnetVersion() {
  const taken = takenVersions();
  let major = 3;
  while (taken.has(`${major}.0.0`)) major += 1;
  return `${major}.0.0`;
}

function parts(version) {
  return version.split(".").map((part) => Number(part));
}

function cmp(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function hasAddresses(env) {
  return Object.values(env?.contracts ?? {}).some((value) => /^0x[0-9a-fA-F]{40}$/.test(value));
}

function extract(version) {
  const dir = mkdtempSync(path.join(tmpdir(), "abi-plan-"));
  const packed = execFileSync("npm", ["pack", `${pkg}@${version}`, "--silent", "--pack-destination", dir], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
  execFileSync("tar", ["-xzf", path.join(dir, packed), "-C", dir]);
  return { dir, pkgRoot: path.join(dir, "package") };
}

function setVersion(version) {
  if (dryRun) return;
  execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: root, stdio: "inherit" });
}

function bump(version, level) {
  if (dryRun) {
    const [x, y, z] = parts(version);
    if (level === "major") return `${x + 1}.0.0`;
    if (level === "minor") return `${x}.${y + 1}.0`;
    if (level === "patch") return `${x}.${y}.${z + 1}`;
    return version;
  }
  setVersion(version);
  execFileSync("npm", ["version", level, "--no-git-tag-version"], { cwd: root, stdio: "inherit" });
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
}

const channel = process.env.CHANNEL === "main" ? "main" : "dev";
const distTag = channel === "main" ? "latest" : "dev";
const owned = channel === "main" ? "mainnet" : "testnet";
const forced = process.env.FORCED_VERSION || "";

if (forced) {
  setVersion(forced);
  console.log(`Forced version ${forced} on dist-tag ${distTag}`);
  emit({ level: "forced", version: forced, dist_tag: distTag });
  process.exit(0);
}

const tags = distTags();
const current = JSON.parse(readFileSync(path.join(root, "deployments.json"), "utf8"));

if (channel === "main" && !hasAddresses(current.environments?.mainnet)) {
  console.log("Mainnet addresses are empty — not publishing to latest");
  emit({ level: "none", version: tags.latest || "", dist_tag: distTag });
  process.exit(0);
}

if (!tags.latest) {
  const version = channel === "main" ? firstMainnetVersion() : JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  setVersion(version);
  console.log(`First publish ${pkg}@${version} (${distTag})`);
  emit({ level: "first", version, dist_tag: distTag });
  process.exit(0);
}

if (channel === "main") {
  const latest = extract(tags.latest);
  try {
    const published = JSON.parse(readFileSync(path.join(latest.pkgRoot, "deployments.json"), "utf8"));
    if (!hasAddresses(published.environments?.mainnet)) {
      const version = firstMainnetVersion();
      setVersion(version);
      console.log(`First mainnet manifest — publishing ${pkg}@${version} on latest`);
      emit({ level: "mainnet", version, dist_tag: distTag });
      process.exit(0);
    }
  } finally {
    rmSync(latest.dir, { recursive: true, force: true });
  }
}

const zero = versionsOf().filter((version) => /^0\.\d+\.\d+$/.test(version)).sort(cmp);
const base = channel === "main" ? tags.latest : [tags.dev, zero.at(-1)].filter(Boolean).sort(cmp).at(-1);
const extracted = extract(base);
let raw;
let ownedChanged = false;
try {
  raw = execFileSync("node", ["scripts/semver-diff.mjs", extracted.pkgRoot, root, owned], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const published = JSON.parse(readFileSync(path.join(extracted.pkgRoot, "deployments.json"), "utf8"));
  ownedChanged =
    canonDeploy(published.environments?.[owned]) !== canonDeploy(current.environments?.[owned]);
} finally {
  rmSync(extracted.dir, { recursive: true, force: true });
}
console.log(`Published ${base} (${distTag} base) — ABI diff requires: ${raw}`);

let level = raw;
if (channel === "dev" && raw !== "none") level = raw === "patch" && !ownedChanged ? "patch" : "minor";
if (channel === "dev" && !tags.dev && (level === "none" || level === "patch")) {
  level = "minor";
  console.log("No dev dist-tag yet — publishing a minor so testnet has its own tag");
}

if (level === "none") {
  console.log("No ABI or owned-environment changes — skipping publish");
  emit({ level: "none", version: base, dist_tag: distTag });
  process.exit(0);
}

const version = bump(base, level);
console.log(`Version: ${version} (${level} from ${base}) on dist-tag ${distTag}`);
emit({ level, version, dist_tag: distTag });
