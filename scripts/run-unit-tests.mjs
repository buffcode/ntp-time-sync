// Runner for the unit test suite.
//
// Compiles src/ and test/unit/ to CommonJS with tsc (tsconfig.test.json) into
// .test-build/, then spawns `node --test` on every compiled *.test.js file.
// Compiling with tsc also type-checks the tests.

import { readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const buildRoot = join(projectRoot, ".test-build");
const testRoot = join(buildRoot, "test", "unit");

function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (st.isFile() && entry.endsWith(".test.js")) {
      out.push(relative(projectRoot, full));
    }
  }
  return out;
}

rmSync(buildRoot, { recursive: true, force: true });

const tscPackage = require.resolve("typescript/package.json");
const tsc = join(dirname(tscPackage), require(tscPackage).bin.tsc);
const compile = spawnSync(process.execPath, [tsc, "-p", "tsconfig.test.json"], {
  stdio: "inherit",
  cwd: projectRoot,
});
if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

const testFiles = collectTestFiles(testRoot).sort();
if (testFiles.length === 0) {
  console.error("No test files found under test/unit/");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  cwd: projectRoot,
});

process.exit(result.status ?? 1);
