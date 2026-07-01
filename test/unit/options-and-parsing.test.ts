// Tests for constructor option validation and server-string parsing.
// Both live in the constructor path; server parsing is inspected via the
// same private-field cast used by instance-isolation.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NtpTimeSync } from "../../src/NtpTimeSync";

type ParsedServers = { options: { servers: Array<{ host: string; port: number }> } };
const serversOf = (sync: NtpTimeSync) => (sync as unknown as ParsedServers).options.servers;

test("unknown top-level options are rejected", () => {
  assert.throws(
    () => new NtpTimeSync({ bogus: 1 } as any),
    /Invalid option: bogus/,
    "a misspelled/unsupported option must throw"
  );
});

test("unknown nested ntpDefaults options are rejected", () => {
  assert.throws(
    () => new NtpTimeSync({ ntpDefaults: { nope: 1 } } as any),
    /Invalid option: nope/,
    "a misspelled nested option must throw"
  );
});

test("valid options (including partial nested overrides) are accepted", () => {
  assert.doesNotThrow(() => {
    new NtpTimeSync({
      servers: ["time.example"],
      sampleCount: 4,
      replyTimeout: 1000,
      ntpDefaults: { port: 1234 },
    });
  });
});

test("parses hostname without a port to the default port", () => {
  const sync = new NtpTimeSync({ servers: ["pool.ntp.org"] });
  assert.deepEqual(serversOf(sync)[0], { host: "pool.ntp.org", port: 123 });
});

test("parses hostname and IPv4 with an explicit port", () => {
  const sync = new NtpTimeSync({ servers: ["pool.ntp.org:5000", "192.0.2.10:5001"] });
  assert.deepEqual(serversOf(sync)[0], { host: "pool.ntp.org", port: 5000 });
  assert.deepEqual(serversOf(sync)[1], { host: "192.0.2.10", port: 5001 });
});

test("parses a bracketed IPv6 literal with and without a port", () => {
  const sync = new NtpTimeSync({ servers: ["[2001:db8::1]", "[2001:db8::1]:9999", "[::1]:123"] });
  assert.deepEqual(serversOf(sync)[0], { host: "2001:db8::1", port: 123 });
  assert.deepEqual(serversOf(sync)[1], { host: "2001:db8::1", port: 9999 });
  assert.deepEqual(serversOf(sync)[2], { host: "::1", port: 123 });
});

test("parses a bare IPv6 literal as host-only with the default port", () => {
  // Without brackets the colons are part of the address, not a port separator.
  const sync = new NtpTimeSync({ servers: ["2001:db8::1", "::1"] });
  assert.deepEqual(serversOf(sync)[0], { host: "2001:db8::1", port: 123 });
  assert.deepEqual(serversOf(sync)[1], { host: "::1", port: 123 });
});

test("falls back to the default port for an invalid port value", () => {
  const sync = new NtpTimeSync({ servers: ["host.example:notaport", "host.example:0", "host.example:70000"] });
  for (const parsed of serversOf(sync)) {
    assert.equal(parsed.host, "host.example");
    assert.equal(parsed.port, 123);
  }
});

test("respects a custom default port from ntpDefaults for unspecified ports", () => {
  const sync = new NtpTimeSync({ servers: ["host.example", "[::1]"], ntpDefaults: { port: 4242 } });
  assert.equal(serversOf(sync)[0].port, 4242);
  assert.equal(serversOf(sync)[1].port, 4242);
});
