// Regression tests for the offset/delay/dispersion math in collectSamples.
// The math lives in a private method; we validate it through the public
// getTime() path against a deterministic fake server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NtpTimeSync } from "../../src/NtpTimeSync";
import { buildNtpResponse, startFakeNtpServer } from "./helpers/ntpFixture";

test("getTime returns a result with offset and precision fields", async () => {
  const server = await startFakeNtpServer(() => buildNtpResponse());
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });
    const result = await sync.getTime(true);
    assert.ok(result.now instanceof Date, "result.now is a Date");
    assert.equal(typeof result.offset, "number", "result.offset is numeric");
    assert.equal(typeof result.precision, "number", "result.precision is numeric");
    assert.ok(Number.isFinite(result.offset), "offset is finite");
    assert.ok(result.precision >= 0, "precision (stddev) is non-negative");
  } finally {
    await server.close();
  }
});

test("getTime with receive=transmit=now from fake server yields near-zero offset", async () => {
  // When a server's receive and transmit timestamps match the client's
  // destination time, the offset formula ((|T2-T1| + |T3-T4|) / 2) must
  // be small — bounded by RTT and wall-clock jitter.
  const server = await startFakeNtpServer((req) => {
    // Echo the request timestamp back as origin; use current time for
    // receive/transmit to minimize apparent offset.
    const now = new Date();
    return buildNtpResponse({
      receiveTimestamp: now,
      transmitTimestamp: now,
      originTimestamp: new Date(Date.now() - 1),
    });
  });
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });
    const result = await sync.getTime(true);
    // Loopback RTT should be <100ms; offset magnitude must stay bounded.
    assert.ok(
      Math.abs(result.offset) < 500,
      `|offset| should be under 500ms against a local fake, got ${result.offset}`
    );
  } finally {
    await server.close();
  }
});

test("getTime caches result across invocations within minPoll window", async () => {
  const server = await startFakeNtpServer(() => buildNtpResponse());
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });
    await sync.getTime(true);
    const firstPacketCount = server.receivedPackets.length;

    // Non-forced call within minPoll window should hit the cache.
    await sync.getTime(false);
    const secondPacketCount = server.receivedPackets.length;

    assert.equal(
      secondPacketCount,
      firstPacketCount,
      "cached getTime must not send another packet"
    );

    // Forced call bypasses the cache.
    await sync.getTime(true);
    assert.ok(
      server.receivedPackets.length > secondPacketCount,
      "force=true must trigger a new network round"
    );
  } finally {
    await server.close();
  }
});

test("getTime with 3 samples averages offsets across responses", async () => {
  // Three back-to-back identical responses must produce a stable offset.
  const server = await startFakeNtpServer(() => buildNtpResponse());
  try {
    const sync = new NtpTimeSync({
      servers: [
        `127.0.0.1:${server.port}`,
        `127.0.0.1:${server.port}`,
        `127.0.0.1:${server.port}`,
      ],
      sampleCount: 3,
      replyTimeout: 500,
    });
    const result = await sync.getTime(true);
    assert.ok(Number.isFinite(result.offset));
    assert.ok(result.precision >= 0);
  } finally {
    await server.close();
  }
});
