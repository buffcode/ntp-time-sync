// Helpers for building synthetic NTP response packets and running an in-process
// UDP server. Kept deterministic and offline so the unit suite can complete
// in well under a second without any external network access.

import * as dgram from "node:dgram";
import { AddressInfo } from "node:net";

const NTP_EPOCH_OFFSET_SECONDS = 2208988800; // 1970-01-01 in NTP seconds-since-1900

export interface BuildPacketOptions {
  leapIndicator?: number;
  version?: number;
  mode?: number;
  stratum?: number;
  poll?: number;
  /** Raw byte value (0-255). -18 would be written as 0xee (two's complement). */
  precisionByte?: number;
  /** Root delay in seconds (added to NTP epoch when written). */
  rootDelaySeconds?: number;
  rootDispersionSeconds?: number;
  referenceId?: number;
  referenceTimestamp?: Date;
  originTimestamp?: Date;
  receiveTimestamp?: Date;
  transmitTimestamp?: Date;
  /**
   * When true, zero out the 64-bit slot for the field. This lets tests
   * produce packets whose parsed timestamps come back as 1900-01-01 to
   * validate acceptResponse missing-field handling while still keeping a
   * schema-correct 48-byte buffer.
   */
  blankReceiveTimestamp?: boolean;
  blankTransmitTimestamp?: boolean;
  blankOriginTimestamp?: boolean;
}

function writeNtpTimestamp(buf: Buffer, offset: number, date: Date): void {
  // Convert a JS Date to an NTP 64-bit timestamp and write big-endian.
  const unixMs = date.getTime();
  const totalSeconds = unixMs / 1000 + NTP_EPOCH_OFFSET_SECONDS;
  const seconds = Math.trunc(totalSeconds);
  const fractional = Math.trunc((totalSeconds - seconds) * 2 ** 32);
  const mask32 = BigInt("0xffffffff");
  const shift32 = BigInt(32);
  const value = ((BigInt(seconds) & mask32) << shift32) | (BigInt(fractional) & mask32);
  buf.writeBigUInt64BE(value, offset);
}

function writeSecondsSinceEpoch(buf: Buffer, offset: number, seconds: number): void {
  // rootDelay/rootDispersion use a 32-bit "seconds since NTP epoch" field
  // that ntp-packet-parser converts into a Date relative to 1900-01-01.
  const scaled = Math.trunc(seconds);
  buf.writeUInt32BE(scaled, offset);
}

/**
 * Build a 48-byte NTP response packet. Defaults produce a schema-valid, sane
 * packet that acceptResponse should accept.
 */
export function buildNtpResponse(opts: BuildPacketOptions = {}): Buffer {
  const now = new Date();
  const buf = Buffer.alloc(48);

  const leapIndicator = opts.leapIndicator ?? 0;
  const version = opts.version ?? 4;
  const mode = opts.mode ?? 4; // server
  buf[0] = ((leapIndicator & 0x3) << 6) | ((version & 0x7) << 3) | (mode & 0x7);

  buf[1] = opts.stratum ?? 2;
  buf[2] = opts.poll ?? 4;
  // precision byte: default 0xee == -18 two's complement, interpreted by
  // ntp-packet-parser as the raw unsigned byte 238. acceptResponse only
  // checks "!== undefined", so any non-missing byte is accepted.
  buf[3] = opts.precisionByte ?? 0xee;

  writeSecondsSinceEpoch(buf, 4, opts.rootDelaySeconds ?? 0);
  writeSecondsSinceEpoch(buf, 8, opts.rootDispersionSeconds ?? 0);
  buf.writeUInt32BE(opts.referenceId ?? 0, 12);

  // reference timestamp (offset 16)
  writeNtpTimestamp(buf, 16, opts.referenceTimestamp ?? now);
  // origin timestamp (offset 24)
  if (!opts.blankOriginTimestamp) {
    writeNtpTimestamp(buf, 24, opts.originTimestamp ?? new Date(now.getTime() - 1));
  }
  // receive timestamp (offset 32)
  if (!opts.blankReceiveTimestamp) {
    writeNtpTimestamp(buf, 32, opts.receiveTimestamp ?? now);
  }
  // transmit timestamp (offset 40)
  if (!opts.blankTransmitTimestamp) {
    writeNtpTimestamp(buf, 40, opts.transmitTimestamp ?? now);
  }

  return buf;
}

export interface FakeNtpServer {
  port: number;
  receivedPackets: Buffer[];
  close(): Promise<void>;
}

/**
 * Start a UDP server on 127.0.0.1:0 that echoes a synthetic reply for every
 * inbound NTP request. The reply is produced by `buildReply(requestBuffer)`.
 * Returning `null` suppresses the reply (tests can simulate drop / timeout).
 */
export async function startFakeNtpServer(
  buildReply: (request: Buffer) => Buffer | null
): Promise<FakeNtpServer> {
  const socket = dgram.createSocket("udp4");
  const received: Buffer[] = [];

  socket.on("message", (msg: Buffer, rinfo) => {
    received.push(Buffer.from(msg));
    const reply = buildReply(msg);
    if (reply) {
      socket.send(reply, 0, reply.length, rinfo.port, rinfo.address);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });

  const addr = socket.address() as AddressInfo;

  return {
    port: addr.port,
    receivedPackets: received,
    close: () =>
      new Promise<void>((resolve) => {
        socket.removeAllListeners();
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}
