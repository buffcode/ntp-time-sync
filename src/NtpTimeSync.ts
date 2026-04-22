"use strict";

import * as dgram from "node:dgram";
import { NtpPacket, NtpPacketParser } from "ntp-packet-parser";
import { NtpTimeResult } from "./NtpTimeResult.js";
import { RecursivePartial } from "./RecursivePartial.js";

export interface NtpTimeSyncConstructorOptions {
  servers: string[];
  sampleCount: number;
  replyTimeout: number;
  ntpDefaults: {
    port: number;
    version: number;
    tolerance: number;
    minPoll: number;
    maxPoll: number;
    maxDispersion: number;
    minDispersion: number;
    maxDistance: number;
    maxStratum: number;
    precision: number;
    referenceDate: Date;
  };
}

export interface NtpTimeSyncOptions extends Omit<NtpTimeSyncConstructorOptions, "servers"> {
  servers: ReadonlyArray<{
    host: string;
    port: number;
  }>;
}

export const NtpTimeSyncDefaultOptions = {
  // list of NTP time servers, optionally including a port (defaults to options.ntpDefaults.port = 123)
  servers: ["0.pool.ntp.org", "1.pool.ntp.org", "2.pool.ntp.org", "3.pool.ntp.org"],

  // required amount of valid samples
  sampleCount: 8,

  // amount of time in milliseconds to wait for an NTP response
  replyTimeout: 3000,

  // defaults as of RFC5905
  ntpDefaults: {
    port: 123,
    version: 4,
    tolerance: 15e-6,
    minPoll: 4,
    maxPoll: 17,
    maxDispersion: 16,
    minDispersion: 0.005,
    maxDistance: 1,
    maxStratum: 16,
    precision: -18,
    referenceDate: new Date("Jan 01 1900 GMT"),
  },
};

interface NtpReceivedPacket extends Partial<NtpPacket> {
  destinationTimestamp: Date;
}

interface SampleData {
  data: NtpReceivedPacket;
  offset: number;
  delay: number;
  dispersion: number;
}

export class NtpTimeSync {
  private static singleton: NtpTimeSync | undefined;

  private options: NtpTimeSyncOptions;
  private samples: SampleData[] = [];
  private lastPoll: number | undefined;
  private lastResult:
    | undefined
    | {
        offset: number;
        precision: number;
      };

  constructor(options: RecursivePartial<NtpTimeSyncConstructorOptions> = {}) {
    const serverConfig = options.servers || NtpTimeSyncDefaultOptions.servers;

    const mergedConfig = this.recursiveResolveOptions(
      options,
      NtpTimeSyncDefaultOptions
    ) as NtpTimeSyncConstructorOptions;

    this.options = {
      ...mergedConfig,
      servers: serverConfig
        .filter((server): server is string => server !== undefined)
        .map((server) => {
          const parts = server.split(":", 2);
          return {
            host: parts[0] ?? server,
            port: Number(parts[1]) || mergedConfig.ntpDefaults.port,
          };
        }),
    };
  }

  private recursiveResolveOptions(
    options: { [key: string]: any },
    defaults: { [key: string]: any }
  ): { [key: string]: any } {
    const mergedConfig: [string, any][] = Object.entries(defaults).map(([key, value]) => {
      // option was not defined in input
      if (!(key in options)) {
        return [key, value];
      }

      // option is invalid
      if (!(key in defaults)) {
        throw new Error(`Invalid option: ${key}`);
      }

      if (Array.isArray(options[key])) {
        return [key, options[key]];
      }

      if (NtpTimeSync.isPlainObject(options[key])) {
        return [key, this.recursiveResolveOptions(options[key], defaults[key])];
      }

      return [key, options[key]];
    });

    return Object.fromEntries(mergedConfig);
  }

  // @see https://quickref.me/check-if-a-value-is-a-plain-object.html
  private static isPlainObject(v: any): boolean {
    if (!v || typeof v !== "object") return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || proto === Object.prototype;
  }

  /**
   * Returns a singleton
   */
  static getInstance(options: RecursivePartial<NtpTimeSyncConstructorOptions> = {}): NtpTimeSync {
    if (!NtpTimeSync.singleton) {
      NtpTimeSync.singleton = new NtpTimeSync(options);
    }

    return NtpTimeSync.singleton;
  }

  private async collectSamples(numSamples: number) {
    let ntpResults: NtpReceivedPacket[] = [];
    let retry = 0;

    do {
      let timePromises: Promise<NtpReceivedPacket>[] = [];

      this.options.servers.forEach((server) => {
        timePromises.push(
          this.getNetworkTime(server.host, server.port).then((data) => {
            this.acceptResponse(data);

            return data;
          })
        );
      });

      // wait for NTP responses to arrive
      ntpResults = ntpResults
        .concat(await Promise.all(timePromises.map((p) => p.catch((e) => e))))
        .filter(function (result) {
          return !(result instanceof Error);
        });

      if (ntpResults.length === 0) {
        retry++;
      }
    } while (ntpResults.length < numSamples && retry < 3);

    if (ntpResults.length === 0) {
      throw new Error("Connection error: Unable to get any NTP response after " + retry + " retries");
    }

    // filter erroneous responses, use valid ones as samples
    let samples: SampleData[] = [];
    ntpResults.forEach((data) => {
      const transmitTimestamp = data.transmitTimestamp;
      const receiveTimestamp = data.receiveTimestamp;
      const originTimestamp = data.originTimestamp;
      const precision = data.precision;

      // acceptResponse has already validated these fields; narrow for the type system
      if (
        transmitTimestamp === undefined ||
        receiveTimestamp === undefined ||
        originTimestamp === undefined ||
        precision === undefined
      ) {
        return;
      }

      const offsetSign = transmitTimestamp.getTime() > data.destinationTimestamp.getTime() ? 1 : -1;

      const offset =
        ((Math.abs(receiveTimestamp.getTime() - originTimestamp.getTime()) +
          Math.abs(transmitTimestamp.getTime() - data.destinationTimestamp.getTime())) /
          2) *
        offsetSign;

      const delay = Math.max(
        data.destinationTimestamp.getTime() -
          originTimestamp.getTime() -
          (receiveTimestamp.getTime() - transmitTimestamp.getTime()),
        Math.pow(2, this.options.ntpDefaults.precision)
      );

      const dispersion =
        Math.pow(2, precision) +
        Math.pow(2, this.options.ntpDefaults.precision) +
        this.options.ntpDefaults.tolerance * (data.destinationTimestamp.getTime() - originTimestamp.getTime());

      samples.push({
        data: data,
        offset: offset,
        delay: delay,
        dispersion: dispersion,
      });
    });

    // sort samples by ascending delay
    samples.sort(function (a, b) {
      return a.delay - b.delay;
    });

    // restrict to best n samples
    return samples.slice(0, numSamples);
  }

  /**
   * @param {boolean} force Force NTP update
   */
  async getTime(force = false): Promise<NtpTimeResult> {
    if (
      !force &&
      this.lastPoll &&
      this.lastResult &&
      Date.now() - this.lastPoll < Math.pow(2, this.options.ntpDefaults.minPoll) * 1000
    ) {
      let date = new Date();
      date.setUTCMilliseconds(date.getUTCMilliseconds() + this.lastResult.offset);

      return {
        now: date,
        offset: this.lastResult.offset,
        precision: this.lastResult.precision,
      };
    }

    // update time samples
    this.samples = await this.collectSamples(this.options.sampleCount);

    // calculate offset
    const offset =
      this.samples.reduce((acc, item) => {
        return acc + item.offset;
      }, 0) / this.samples.length;

    const precision = NtpTimeSync.stdDev(this.samples.map((sample) => sample.offset));

    this.lastResult = {
      offset: offset,
      precision: precision,
    };
    this.lastPoll = Date.now();

    let date = new Date();
    date.setUTCMilliseconds(date.getUTCMilliseconds() + offset);

    return {
      now: date,
      offset: offset,
      precision: precision,
    };
  }

  /**
   * Will return the correct timestamp when function was called
   */
  async now(force = false) {
    const now = new Date();
    const result = await this.getTime(force);

    now.setUTCMilliseconds(now.getUTCMilliseconds() + result.offset);
    return now;
  }

  /**
   * @param {Integer} leapIndicator, defaults to 3 (unsynchronized)
   * @param {Integer} ntpVersion, defaults to `options.ntpDefaults.version`
   * @param {Integer} mode, defaults to 3 (client)
   * @return {Buffer}
   */
  private createPacket(leapIndicator = 3, ntpVersion: number | undefined = undefined, mode = 3): Buffer {
    ntpVersion = ntpVersion || this.options.ntpDefaults.version;

    const buf = Buffer.alloc(48);

    // Leap indicator (2 bits) | NTP version (3 bits) | mode (3 bits)
    buf[0] = ((leapIndicator & 0x3) << 6) | ((ntpVersion & 0x7) << 3) | (mode & 0x7);

    // origin timestamp: seconds since 1900 epoch in upper 32 bits,
    // fractional seconds (scaled by 2^32) in lower 32 bits
    const baseTimeMs = new Date().getTime() - this.options.ntpDefaults.referenceDate.getTime();
    const seconds = Math.trunc(baseTimeMs / 1000);
    const fractional = Math.trunc(((baseTimeMs % 1000) / 1000) * 2 ** 32);
    const mask32 = BigInt("0xffffffff");
    const shift32 = BigInt(32);
    const ntpTimestamp = ((BigInt(seconds) & mask32) << shift32) | (BigInt(fractional) & mask32);

    // origin timestamp
    buf.writeBigUInt64BE(ntpTimestamp, 24);
    // transmit timestamp
    buf.writeBigUInt64BE(ntpTimestamp, 40);

    return buf;
  }

  private static cleanup(client: dgram.Socket) {
    try {
      client.close();
    } catch (e) {
      // ignore, as we just want to cleanup
    }
  }

  getNetworkTime(server: string, port = 123): Promise<NtpReceivedPacket> {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket("udp4");
      let hasFinished = false;

      const errorCallback = (err: Error) => {
        if (timeoutHandler !== undefined) {
          clearTimeout(timeoutHandler);
          timeoutHandler = undefined;
        }

        if (hasFinished) {
          return;
        }

        NtpTimeSync.cleanup(client);

        hasFinished = true;
        reject(err);
      };

      client.on("error", (err: Error) => errorCallback(err));

      // setup timeout
      let timeoutHandler: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        errorCallback(new Error("Timeout waiting for NTP response."));
      }, this.options.replyTimeout);

      // Register the message listener BEFORE sending the packet so we never
      // miss an unusually fast reply that arrives between send() completing
      // and the send callback firing.
      client.once("message", (msg: Buffer) => {
        if (hasFinished) {
          return;
        }

        clearTimeout(timeoutHandler);
        timeoutHandler = undefined;
        client.close();

        let parsed: Partial<NtpPacket>;
        try {
          parsed = NtpPacketParser.parse(msg);
        } catch (err) {
          hasFinished = true;
          reject(err);
          return;
        }

        const result: NtpReceivedPacket = {
          ...parsed,
          destinationTimestamp: new Date(),
        };

        hasFinished = true;
        resolve(result);
      });

      client.send(this.createPacket(), port, server, (err: Error | null) => {
        if (hasFinished) {
          return;
        }

        if (err) {
          errorCallback(err);
          return;
        }
      });
    });
  }

  /**
   * Test if response is acceptable for synchronization
   */
  private acceptResponse(data: Partial<NtpPacket>) {
    /*
     * Format error
     */
    if (data.version === undefined || data.version > this.options.ntpDefaults.version) {
      throw new Error("Format error: Expected version " + this.options.ntpDefaults.version + ", got " + data.version);
    }

    /*
     * A stratum error occurs if (1) the server has never been
     * synchronized, (2) the server stratum is invalid.
     */
    if (data.leapIndicator === 3 || data.stratum === undefined || data.stratum >= this.options.ntpDefaults.maxStratum) {
      throw new Error("Stratum error: Remote clock is unsynchronized");
    }

    /*
     * Verify valid root distance.
     */
    if (data.rootDelay === undefined || data.rootDispersion === undefined) {
      throw new Error("Format error: Missing root delay or root dispersion");
    }
    const rootDelay = (data.rootDelay.getTime() - this.options.ntpDefaults.referenceDate.getTime()) / 1000;
    const rootDispersion = (data.rootDispersion.getTime() - this.options.ntpDefaults.referenceDate.getTime()) / 1000;
    if (rootDelay / 2 + rootDispersion >= this.options.ntpDefaults.maxDispersion) {
      throw new Error("Distance error: Root distance too large");
    }

    /*
     * Verify origin timestamp
     */
    if (data.originTimestamp === undefined || data.originTimestamp.getTime() > new Date().getTime()) {
      throw new Error("Format error: Origin timestamp is from the future");
    }

    /*
     * Verify remaining fields required for sample computation
     */
    if (data.transmitTimestamp === undefined) {
      throw new Error("Format error: Missing transmit timestamp");
    }
    if (data.receiveTimestamp === undefined) {
      throw new Error("Format error: Missing receive timestamp");
    }
    if (data.precision === undefined) {
      throw new Error("Format error: Missing precision");
    }
  }

  /**
   * Average for a list of numbers
   */
  private static avg(values: number[]): number {
    const sum = values.reduce(function (sum, value) {
      return sum + value;
    }, 0);

    return sum / values.length;
  }

  /**
   * Standard deviation for a list of numbers
   */
  private static stdDev(values: number[]): number {
    const avg = this.avg(values);

    const squareDiffs = values.map(function (value) {
      const diff = value - avg;
      return diff * diff;
    });

    return Math.sqrt(this.avg(squareDiffs));
  }
}
