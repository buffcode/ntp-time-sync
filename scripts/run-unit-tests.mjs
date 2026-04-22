// Runner for the unit test suite.
//
// Discovers every test/unit/**/*.test.ts file and spawns `node --test` with
// ts-node's transpile-only CJS hook registered. Uses TS_NODE_COMPILER_OPTIONS
// to force CommonJS compilation with bundler resolution so that the source's
// `.js`-suffixed ESM-style imports resolve correctly under Yarn PnP without
// pulling in a PnP ESM loader.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const testRoot = join(projectRoot, "test", "unit");

function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (st.isFile() && entry.endsWith(".test.ts")) {
      out.push(relative(projectRoot, full));
    }
  }
  return out;
}

const testFiles = collectTestFiles(testRoot).sort();
if (testFiles.length === 0) {
  console.error("No test files found under test/unit/");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", "--require", "ts-node/register/transpile-only", ...testFiles],
  {
    stdio: "inherit",
    cwd: projectRoot,
    env: {
      ...process.env,
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({
        module: "commonjs",
        moduleResolution: "bundler",
      }),
    },
  }
);

process.exit(result.status ?? 1);
