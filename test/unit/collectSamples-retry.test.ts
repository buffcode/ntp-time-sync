// Regression tests for collectSamples' retry accounting.
// The loop must increment `retry` on no-progress rounds and bail after 3
// such rounds, preventing an infinite loop against a server set that never
// produces enough valid samples.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NtpTimeSync } from "../../src/NtpTimeSync";
import { buildNtpResponse, startFakeNtpServer } from "./helpers/ntpFixture";

test("collectSamples bails out after 3 no-progress retry rounds when no samples arrive", async () => {
  // Server never replies; every round produces zero new samples → retry++
  // on each iteration. With replyTimeout=200ms and retry limit=3, total
  // wall time is bounded near 4 * 200ms = ~800ms.
  const server = await startFakeNtpServer(() => null);
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 4,
      replyTimeout: 150,
    });

    const start = Date.now();
    await assert.rejects(
      () => sync.getTime(true),
      /Unable to get any NTP response/i,
      "getTime must reject with a connection error after retries exhaust"
    );
    const elapsed = Date.now() - start;

    // 4 rounds * 150ms timeout = 600ms base. Allow generous safety margin
    // but ensure we didn't loop unbounded.
    assert.ok(elapsed < 3000, `must bail out quickly, took ${elapsed}ms`);
    assert.ok(elapsed >= 400, `should observe at least a few timeouts, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test("collectSamples terminates when partial samples never reach target count", async () => {
  // Server responds to every request, but we ask for more samples than we
  // can produce in a single round. Because every round produces the SAME
  // new sample count, ntpResults grows → retry stays at 0 for progress
  // rounds and increments when the round produces duplicates / no growth.
  // With 1 server + sampleCount=5, each round adds exactly 1 sample → no
  // progress after round 1 because ntpResults.length keeps increasing...
  // actually it IS progress. So to force termination we use sampleCount
  // HIGHER than achievable and verify the implementation doesn't spin
  // forever.
  let requestCount = 0;
  const server = await startFakeNtpServer(() => {
    requestCount++;
    // Return a malformed packet (wrong length) so the parser throws and
    // acceptResponse never gets a valid sample. This keeps ntpResults
    // length at 0, triggering the no-progress retry path.
    return Buffer.alloc(10); // invalid length, parser will reject
  });
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 3,
      replyTimeout: 150,
    });

    const start = Date.now();
    await assert.rejects(
      () => sync.getTime(true),
      /Unable to get any NTP response/i,
      "must reject when parser rejects every response"
    );
    const elapsed = Date.now() - start;

    // 4 rounds should have occurred before bailing.
    assert.ok(requestCount >= 3, `server should have received ≥3 requests, got ${requestCount}`);
    assert.ok(elapsed < 3000, `bounded termination time, got ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test("collectSamples produces a result when sampleCount is satisfied in one round", async () => {
  const server = await startFakeNtpServer(() => buildNtpResponse());
  try {
    const sync = new NtpTimeSync({
      servers: [
        `127.0.0.1:${server.port}`,
        `127.0.0.1:${server.port}`,
      ],
      sampleCount: 2,
      replyTimeout: 500,
    });
    const result = await sync.getTime(true);
    assert.ok(Number.isFinite(result.offset), "offset produced when targets met in one round");
  } finally {
    await server.close();
  }
});
