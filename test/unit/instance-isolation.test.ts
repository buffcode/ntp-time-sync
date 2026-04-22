// Regression test for the module-level-state → instance-state refactor.
// Two independent NtpTimeSync instances with different server lists must
// maintain independent caches. This test fails against the old code where
// lastResult / samples lived at module scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NtpTimeSync } from "../../src/NtpTimeSync";
import { buildNtpResponse, startFakeNtpServer } from "./helpers/ntpFixture";

test("two NtpTimeSync instances with different servers keep independent caches", async () => {
  // Server A always reports a time 1 second BEHIND wall clock.
  const serverA = await startFakeNtpServer(() => {
    const skewed = new Date(Date.now() - 1000);
    return buildNtpResponse({
      receiveTimestamp: skewed,
      transmitTimestamp: skewed,
      originTimestamp: new Date(Date.now() - 5),
    });
  });
  // Server B always reports a time 1 second AHEAD of wall clock.
  const serverB = await startFakeNtpServer(() => {
    const skewed = new Date(Date.now() + 1000);
    return buildNtpResponse({
      receiveTimestamp: skewed,
      transmitTimestamp: skewed,
      originTimestamp: new Date(Date.now() - 5),
    });
  });

  try {
    const syncA = new NtpTimeSync({
      servers: [`127.0.0.1:${serverA.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });
    const syncB = new NtpTimeSync({
      servers: [`127.0.0.1:${serverB.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });

    const resultA = await syncA.getTime(true);
    const resultB = await syncB.getTime(true);

    // Offsets must reflect each server's intentional skew, not be cross-
    // contaminated by the other instance.
    assert.ok(resultA.offset < -500, `A should report negative offset (~-1000ms), got ${resultA.offset}`);
    assert.ok(resultB.offset > 500, `B should report positive offset (~+1000ms), got ${resultB.offset}`);

    // Re-read cache; non-forced calls must return each instance's own value.
    const cachedA = await syncA.getTime(false);
    const cachedB = await syncB.getTime(false);
    assert.equal(cachedA.offset, resultA.offset, "A's cache survives B's invocation");
    assert.equal(cachedB.offset, resultB.offset, "B's cache survives A's invocation");

    // And they are distinct.
    assert.notEqual(cachedA.offset, cachedB.offset, "A and B have different cached offsets");

    // Internal state inspection (via TS cast): samples arrays must be
    // separate Array instances, not a shared module-level variable.
    const samplesA = (syncA as unknown as { samples: unknown[] }).samples;
    const samplesB = (syncB as unknown as { samples: unknown[] }).samples;
    assert.notEqual(samplesA, samplesB, "samples arrays are separate objects per instance");
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test("instance options are not shared between constructions", () => {
  const a = new NtpTimeSync({ servers: ["a.example"], sampleCount: 2 });
  const b = new NtpTimeSync({ servers: ["b.example"], sampleCount: 7 });

  const optsA = (a as unknown as { options: { servers: Array<{ host: string }>; sampleCount: number } }).options;
  const optsB = (b as unknown as { options: { servers: Array<{ host: string }>; sampleCount: number } }).options;

  assert.equal(optsA.servers[0].host, "a.example");
  assert.equal(optsB.servers[0].host, "b.example");
  assert.equal(optsA.sampleCount, 2);
  assert.equal(optsB.sampleCount, 7);
  assert.notEqual(optsA, optsB, "options objects are distinct");
});
