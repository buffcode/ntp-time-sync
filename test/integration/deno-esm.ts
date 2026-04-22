// Deno ESM integration test — verifies the ESM dist loads natively under Deno.
// Run: deno run --allow-read test/integration/deno-esm.ts

import { NtpTimeSync } from "../../dist/esm/index.js";

// Instantiate with nested options to exercise recursiveResolveOptions → isPlainObject
new NtpTimeSync({
  sampleCount: 4,
  ntpDefaults: {
    minPoll: 4,
    maxPoll: 10,
  },
});

// Verify singleton
const a = NtpTimeSync.getInstance();
const b = NtpTimeSync.getInstance();
if (a !== b) {
  throw new Error("Singleton check failed: expected same instance");
}

// Verify no __proto__ pollution in resolved options
const opts = (a as unknown as { options: { ntpDefaults: Record<string, unknown> } }).options;
if (Object.getPrototypeOf(opts.ntpDefaults) !== Object.prototype) {
  throw new Error("ntpDefaults prototype is not Object.prototype");
}
if (Object.prototype.hasOwnProperty.call(opts, "__proto__")) {
  throw new Error("options has unexpected __proto__ own property");
}
if (Object.prototype.hasOwnProperty.call(opts.ntpDefaults, "__proto__")) {
  throw new Error("ntpDefaults has unexpected __proto__ own property");
}

console.log("✓ NtpTimeSync imported (ESM) and instantiated");
console.log("✓ Nested options merged without __proto__ issues");
console.log("✓ Singleton pattern works");
