// Writes the appropriate `package.json` marker into dist/{cjs,esm} so Node's
// module resolver treats the emitted .js files with the correct format.
//
// Usage: node scripts/write-package-type.mjs <cjs|esm>

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (target !== "cjs" && target !== "esm") {
  console.error(`Usage: node scripts/write-package-type.mjs <cjs|esm>`);
  process.exit(1);
}

const type = target === "cjs" ? "commonjs" : "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outPath = resolve(__dirname, "..", "dist", target, "package.json");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ type }) + "\n");

console.log(`wrote ${outPath} → {"type":"${type}"}`);
