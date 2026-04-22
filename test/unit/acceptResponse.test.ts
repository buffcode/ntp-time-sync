// Regression tests for acceptResponse's field validation.
// The method is private; we call it through a TypeScript cast to keep the
// test decoupled from the src/ visibility model (no production change).

import { test } from "node:test";
import assert from "node:assert/strict";
import { NtpTimeSync } from "../../src/NtpTimeSync";

type AcceptResponseFn = (data: Record<string, unknown>) => void;

function getAcceptResponse(sync: NtpTimeSync): AcceptResponseFn {
  const fn = (sync as unknown as { acceptResponse: AcceptResponseFn }).acceptResponse;
  assert.equal(typeof fn, "function", "acceptResponse is present on the instance");
  return fn.bind(sync) as AcceptResponseFn;
}

function baseValidPacket(): Record<string, unknown> {
  const now = new Date();
  // rootDelay / rootDispersion are Dates relative to the 1900 NTP epoch once
  // parsed; use the epoch itself so (rootDelay - epoch)/1000 = 0.
  const epoch1900 = new Date("Jan 01 1900 GMT");
  return {
    version: 4,
    leapIndicator: 0,
    stratum: 2,
    rootDelay: epoch1900,
    rootDispersion: epoch1900,
    originTimestamp: new Date(now.getTime() - 10),
    receiveTimestamp: now,
    transmitTimestamp: now,
    precision: -18,
  };
}

test("acceptResponse accepts a schema-valid packet with all required fields", () => {
  const sync = new NtpTimeSync();
  const accept = getAcceptResponse(sync);
  assert.doesNotThrow(() => accept(baseValidPacket()));
});

test("acceptResponse rejects packet missing originTimestamp", () => {
  const sync = new NtpTimeSync();
  const accept = getAcceptResponse(sync);
  const pkt = baseValidPacket();
  delete pkt.originTimestamp;
  assert.throws(() => accept(pkt), /origin timestamp/i);
});

test("acceptResponse rejects packet missing transmitTimestamp", () => {
  const sync = new NtpTimeSync();
  const accept = getAcceptResponse(sync);
  const pkt = baseValidPacket();
  delete pkt.transmitTimestamp;
  assert.throws(() => accept(pkt), /missing transmit timestamp/i);
});

test("acceptResponse rejects packet missing receiveTimestamp", () => {
  const sync = new NtpTimeSync();
  const accept = getAcceptResponse(sync);
  const pkt = baseValidPacket();
  delete pkt.receiveTimestamp;
  assert.throws(() => accept(pkt), /missing receive timestamp/i);
});

test("acceptResponse rejects packet missing precision", () => {
  const sync = new NtpTimeSync();
  const accept = getAcceptResponse(sync);
  const pkt = baseValidPacket();
  delete pkt.precision;
  assert.throws(() => accept(pkt), /missing precision/i);
});

test("acceptResponse rejects packet with originTimestamp in the future", () => {
  const sync = new NtpTimeSync();
  const accept = getAcceptResponse(sync);
  const pkt = baseValidPacket();
  pkt.originTimestamp = new Date(Date.now() + 60_000);
  assert.throws(() => accept(pkt), /from the future/i);
});

test("acceptResponse rejects unsynchronized stratum (leapIndicator=3)", () => {
  const sync = new NtpTimeSync();
  const accept = getAcceptResponse(sync);
  const pkt = baseValidPacket();
  pkt.leapIndicator = 3;
  assert.throws(() => accept(pkt), /unsynchronized/i);
});
