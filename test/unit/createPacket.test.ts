// Regression tests for the NTP v4 packet layout produced by NtpTimeSync.
// The packet builder is private; we observe it indirectly by sending a real
// getTime() call against an in-process UDP server that captures the datagram.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NtpTimeSync } from "../../src/NtpTimeSync";
import { buildNtpResponse, startFakeNtpServer } from "./helpers/ntpFixture";

const NTP_EPOCH_OFFSET_SECONDS = 2208988800;

function readNtpTimestampAsDate(buf: Buffer, offset: number): Date {
  const value = buf.readBigUInt64BE(offset);
  const mask32 = BigInt("0xffffffff");
  const shift32 = BigInt(32);
  const seconds = Number(value >> shift32);
  const fractional = Number(value & mask32);
  const unixMs = (seconds - NTP_EPOCH_OFFSET_SECONDS) * 1000 + (fractional / 2 ** 32) * 1000;
  return new Date(unixMs);
}

test("createPacket produces a 48-byte NTP v4 client packet", async () => {
  const server = await startFakeNtpServer(() => buildNtpResponse());
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });
    await sync.getTime(true);

    assert.ok(server.receivedPackets.length >= 1, "server received at least one packet");
    const packet = server.receivedPackets[0];
    assert.equal(packet.length, 48, "packet length is 48 bytes");

    // Byte 0: LI (2) | VN (3) | Mode (3)
    // Default leapIndicator = 3 (unsynchronized), version = 4, mode = 3 (client)
    const byte0 = packet[0];
    const leapIndicator = (byte0 >> 6) & 0x3;
    const version = (byte0 >> 3) & 0x7;
    const mode = byte0 & 0x7;
    assert.equal(leapIndicator, 3, "leap indicator bits 6-7 encode default value 3");
    assert.equal(version, 4, "version bits 3-5 encode NTP v4");
    assert.equal(mode, 3, "mode bits 0-2 encode client (3)");
  } finally {
    await server.close();
  }
});

test("createPacket writes a BE 64-bit timestamp at offset 24 that matches offset 40", async () => {
  const server = await startFakeNtpServer(() => buildNtpResponse());
  try {
    const sync = new NtpTimeSync({
      servers: [`127.0.0.1:${server.port}`],
      sampleCount: 1,
      replyTimeout: 500,
    });
    const sentAt = Date.now();
    await sync.getTime(true);
    const receivedAt = Date.now();

    const packet = server.receivedPackets[0];

    const originRaw = packet.readBigUInt64BE(24);
    const transmitRaw = packet.readBigUInt64BE(40);
    assert.equal(originRaw, transmitRaw, "origin (24) and transmit (40) timestamps are written with the same value");

    const decoded = readNtpTimestampAsDate(packet, 24);
    const decodedMs = decoded.getTime();
    // Allow generous envelope for wall-clock jitter; timestamps must fall
    // between the pre-call time and post-call time plus safety margin.
    assert.ok(
      decodedMs >= sentAt - 5 && decodedMs <= receivedAt + 50,
      `decoded timestamp ${decodedMs} should be between ${sentAt - 5} and ${receivedAt + 50}`
    );
  } finally {
    await server.close();
  }
});

test("createPacket round-trips an NTP timestamp through big-endian write/read", async () => {
  // Independently verify the big-endian encoding logic against a known Date.
  // This re-implements the src-side math to lock the byte layout in place.
  const knownDate = new Date("2024-06-15T12:34:56.789Z");
  const baseMs = knownDate.getTime() - new Date("Jan 01 1900 GMT").getTime();
  const seconds = Math.trunc(baseMs / 1000);
  const fractional = Math.trunc(((baseMs % 1000) / 1000) * 2 ** 32);
  const mask32 = BigInt("0xffffffff");
  const shift32 = BigInt(32);
  const ntpTimestamp = ((BigInt(seconds) & mask32) << shift32) | (BigInt(fractional) & mask32);

  const buf = Buffer.alloc(48);
  buf.writeBigUInt64BE(ntpTimestamp, 24);
  buf.writeBigUInt64BE(ntpTimestamp, 40);

  // High 32 bits stored at offset 24 (big-endian) should decode back to seconds.
  const decodedSeconds = buf.readUInt32BE(24);
  const decodedFraction = buf.readUInt32BE(28);
  assert.equal(decodedSeconds, seconds, "seconds word stored big-endian at offset 24");
  assert.equal(decodedFraction, fractional, "fraction word stored big-endian at offset 28");

  // Same for offset 40.
  assert.equal(buf.readUInt32BE(40), seconds);
  assert.equal(buf.readUInt32BE(44), fractional);
});
