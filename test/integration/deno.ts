// Deno integration test — verifies ntp-time-sync works without --unstable-unsafe-proto
// Run: deno run test/integration/deno.ts

import { NtpTimeSync } from "../../dist/index.js";

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

console.log("✓ NtpTimeSync imported and instantiated");
console.log("✓ Nested options merged without __proto__ issues");
console.log("✓ Singleton pattern works");
