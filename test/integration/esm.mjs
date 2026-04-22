// ESM integration test — verifies the dual build's ESM output works for `import` consumers.
// Run: node test/integration/esm.mjs

import assert from "node:assert/strict";

import { NtpTimeSync, NtpTimeSyncDefaultOptions } from "../../dist/esm/index.js";

assert.equal(typeof NtpTimeSync, "function", "NtpTimeSync should be exported as a class");
assert.ok(NtpTimeSyncDefaultOptions && typeof NtpTimeSyncDefaultOptions === "object", "defaults should be exported");

// Instantiate with nested options to exercise recursiveResolveOptions → isPlainObject
const instance = new NtpTimeSync({
  sampleCount: 4,
  ntpDefaults: {
    minPoll: 4,
    maxPoll: 10,
  },
});
assert.ok(instance instanceof NtpTimeSync, "constructor should return an NtpTimeSync instance");

// Verify singleton
const a = NtpTimeSync.getInstance();
const b = NtpTimeSync.getInstance();
assert.equal(a, b, "getInstance must return the same singleton");
assert.ok(a instanceof NtpTimeSync, "singleton must be an NtpTimeSync instance");

// Verify API surface (shape only — no network calls)
assert.equal(typeof a.getTime, "function", "getTime must be a method");
assert.equal(typeof a.now, "function", "now must be a method");
assert.equal(typeof a.getNetworkTime, "function", "getNetworkTime must be a method");

// Verify no __proto__ pollution in resolved options
const opts = /** @type {any} */ (a).options;
assert.ok(opts, "instance.options must be defined");
assert.equal(Object.getPrototypeOf(opts.ntpDefaults), Object.prototype, "ntpDefaults must have Object.prototype");
assert.ok(!Object.prototype.hasOwnProperty.call(opts, "__proto__"), "no __proto__ own property on options");
assert.ok(
  !Object.prototype.hasOwnProperty.call(opts.ntpDefaults, "__proto__"),
  "no __proto__ own property on ntpDefaults"
);

console.log("ok - esm integration test passed");
