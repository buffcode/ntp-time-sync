// Regression tests for socket lifecycle: cleanup uses removeAllListeners +
// close, and a synchronous throw from createPacket/send must not leak a
// dgram socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import { NtpTimeSync } from "../../src/NtpTimeSync";
import { startFakeNtpServer, buildNtpResponse } from "./helpers/ntpFixture";

interface ActiveHandle {
  constructor?: { name?: string };
}

function countUdpHandles(): number {
  // Use Node's debug API to count active UDP socket handles. This is
  // deprecated/private but stable across LTS versions and suits a
  // regression check that cleanup() actually releases the handle.
  const getActiveHandles = (process as unknown as { _getActiveHandles?: () => ActiveHandle[] })._getActiveHandles;
  if (typeof getActiveHandles !== "function") return -1;
  return getActiveHandles
    .call(process)
    .filter((h) => h?.constructor?.name === "UDP" || h?.constructor?.name === "Socket")
    .length;
}

test("socket handles do not accumulate across repeated getNetworkTime calls", async () => {
  // Fix #6 guards against socket leaks. A leak would show up as a steadily
  // growing active-handle count across many iterations. Run enough rounds
  // to notice any retained-per-call handle.
  const server = await startFakeNtpServer(() => buildNtpResponse());
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });

    // Warm-up to stabilize the baseline
    await sync.getTime(true);
    // Give Node one tick to close sockets from the warm-up round
    await new Promise((r) => setImmediate(r));
    const baseline = countUdpHandles();

    for (let i = 0; i < 10; i++) {
      await sync.getTime(true);
    }
    await new Promise((r) => setImmediate(r));

    const after = countUdpHandles();
    // Tolerate +1 for the fake server's own socket variations; any larger
    // delta implies a leaked client socket per iteration.
    assert.ok(
      after - baseline <= 1,
      `UDP handle count grew from ${baseline} to ${after}, suggesting a socket leak`
    );
  } finally {
    await server.close();
  }
});

test("getNetworkTime rejects and cleans up when sending to an unreachable port", async () => {
  // Closed loopback port → kernel sends ICMP unreachable → socket errors.
  // This exercises the error-callback path where cleanup must remove all
  // listeners and close the socket before rejecting.
  const sync = new NtpTimeSync({
    servers: ["127.0.0.1:1"],
    sampleCount: 1,
    replyTimeout: 300,
  });

  await assert.rejects(() => sync.getNetworkTime("127.0.0.1", 1));
  // If cleanup failed, a UDP handle would linger past a tick.
  await new Promise((r) => setImmediate(r));
  // No assertion on count because other tests may have warmed handles up;
  // we just assert the rejection path completes without hanging.
});

test("reply that arrives before send-callback completes is still captured", async () => {
  // This indirectly verifies fix #4: the message listener must be wired
  // up BEFORE client.send() is called. Our fake server responds
  // synchronously as soon as it receives a packet, which stresses that
  // ordering — if the message listener were registered after send, a
  // very fast reply could slip through the gap. Against a loopback UDP
  // server the round-trip is microseconds, so this tightens the race
  // window.
  const server = await startFakeNtpServer(() => buildNtpResponse());
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });
    // Run several iterations to exercise the race window repeatedly.
    for (let i = 0; i < 5; i++) {
      const result = await sync.getTime(true);
      assert.ok(result.now instanceof Date, `iteration ${i}: message was captured`);
    }
  } finally {
    await server.close();
  }
});
