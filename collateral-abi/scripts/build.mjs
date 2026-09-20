// Copies the codegen output from contracts/abi into this package:
//   *.ts  -> src/   (compiled to dist/ by tsc)
//   *.json -> json/ (shipped raw for non-TS consumers, e.g. subgraphs)
// and generates src/index.ts re-exporting everything.
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const abiDir = path.resolve(pkgRoot, "../contracts/abi");
const srcDir = path.join(pkgRoot, "src");
const jsonDir = path.join(pkgRoot, "json");

// Test-only mocks are not part of the public package
const EXCLUDE = new Set([]);

rmSync(srcDir, { recursive: true, force: true });
rmSync(jsonDir, { recursive: true, force: true });
mkdirSync(srcDir, { recursive: true });
mkdirSync(jsonDir, { recursive: true });

const modules = [];
for (const file of readdirSync(abiDir).sort()) {
  const base = file.replace(/\.(ts|json)$/, "");
  if (EXCLUDE.has(base)) continue;
  if (file.endsWith(".ts")) {
    copyFileSync(path.join(abiDir, file), path.join(srcDir, file));
    modules.push(base);
  } else if (file.endsWith(".json")) {
    copyFileSync(path.join(abiDir, file), path.join(jsonDir, file));
  }
}

const index = modules.map((name) => `export * from "./${name}.js";`).join("\n");
writeFileSync(path.join(srcDir, "index.ts"), `${index}\n`);

console.log(`Copied ${modules.length} ABI modules from contracts/abi`);
