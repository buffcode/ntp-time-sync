"use strict";

import * as dgram from "dgram";
import { NtpPacket, NtpPacketParser } from "ntp-packet-parser";
import { NtpTimeResult } from "./NtpTimeResult";
import { RecursivePartial } from "./RecursivePartial";
import { debug as initDebug } from "debug";

const debug = initDebug("ntp-time-sync");
let singleton: NtpTimeSync | undefined;
let lastPoll: number | undefined;
let lastResult:
  | undefined
  | {
      offset: number;
      precision: number;
    };

export interface NtpTimeSyncConstructorOptions {
  servers: string[];
  sampleCount: number;
  replyTimeout: number;
  maxRetries: number;
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

export const NtpTimeSyncDefaultOptions: NtpTimeSyncConstructorOptions = {
  // list of NTP time servers, optionally including a port (defaults to options.ntpDefaults.port = 123)
  servers: ["0.pool.ntp.org", "1.pool.ntp.org", "2.pool.ntp.org", "3.pool.ntp.org"],

  // required amount of valid samples
  sampleCount: 8,

  // amount of time in milliseconds to wait for an NTP response
  replyTimeout: 3000,

  // maximum number of times to retry a request
  maxRetries: 3,

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
  private _options: NtpTimeSyncOptions;
  private samples: SampleData[] = [];

  constructor(options: RecursivePartial<NtpTimeSyncConstructorOptions> = {}) {
    const serverConfig = options.servers || NtpTimeSyncDefaultOptions.servers;

    const mergedConfig = this.recursiveResolveOptions(
      options,
      NtpTimeSyncDefaultOptions
    ) as NtpTimeSyncConstructorOptions;

    this._options = {
      ...mergedConfig,
      servers: serverConfig.map((server) => {
        return {
          host: server.split(":", 2)[0],
          port: Number(server.split(":", 2)[1]) || mergedConfig.ntpDefaults.port,
        };
      }),
    };

    debug("Constructed with options: %O", this._options);
  }

  public get options(): NtpTimeSyncOptions {
    return { ...this._options };
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

      const isObject = typeof options[key] === "object" && options[key] !== null;
      if (isObject) {
        return [key, this.recursiveResolveOptions(options[key], defaults[key])];
      }

      return [key, options[key]];
    });

    return Object.fromEntries(mergedConfig);
  }

  /**
   * Returns a singleton
   */
  static getInstance(options: RecursivePartial<NtpTimeSyncConstructorOptions> = {}): NtpTimeSync {
    if (!singleton) {
      debug("Returning new instance");
      singleton = new NtpTimeSync(options);
    } else {
      debug("Returning singleton instance");
    }

    return singleton;
  }

  private async collectSamples(numSamples: number) {
    let ntpResults: NtpReceivedPacket[] = [];
    let retry = 0;

    debug("Collecting %d samples from %d server(s)", numSamples, this._options.servers.length);

    do {
      let timePromises: Promise<NtpReceivedPacket>[] = [];

      this._options.servers.forEach((server) => {
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
          if (result instanceof Error) {
            debug("Discarded result: %s", result.message);
          }

          return !(result instanceof Error);
        });

      if (ntpResults.length === 0) {
        debug("No valid responses received on iteration %d / %d", retry + 1, this._options.maxRetries);
        retry++;
      }
    } while (ntpResults.length < numSamples && retry < this._options.maxRetries);

    if (ntpResults.length === 0) {
      debug("No results received, giving up");
      throw new Error("Connection error: Unable to get any NTP response after " + retry + " retries");
    }

    // filter erroneous responses, use valid ones as samples
    let samples: SampleData[] = [];
    ntpResults.forEach((data) => {
      const offsetSign = data.transmitTimestamp.getTime() > data.destinationTimestamp.getTime() ? 1 : -1;

      const offset =
        ((Math.abs(data.receiveTimestamp.getTime() - data.originTimestamp.getTime()) +
          Math.abs(data.transmitTimestamp.getTime() - data.destinationTimestamp.getTime())) /
          2) *
        offsetSign;

      const delay = Math.max(
        data.destinationTimestamp.getTime() -
          data.originTimestamp.getTime() -
          (data.receiveTimestamp.getTime() - data.transmitTimestamp.getTime()),
        Math.pow(2, this._options.ntpDefaults.precision)
      );

      const dispersion =
        Math.pow(2, data.precision) +
        Math.pow(2, this._options.ntpDefaults.precision) +
        this._options.ntpDefaults.tolerance * (data.destinationTimestamp.getTime() - data.originTimestamp.getTime());

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
    if (!force && lastPoll && Date.now() - lastPoll < Math.pow(2, this._options.ntpDefaults.minPoll) * 1000) {
      let date = new Date();
      date.setUTCMilliseconds(date.getUTCMilliseconds() + lastResult.offset);

      return {
        now: date,
        offset: lastResult.offset,
        precision: lastResult.precision,
      };
    }

    // update time samples
    this.samples = await this.collectSamples(this._options.sampleCount);

    // calculate offset
    const offset =
      this.samples.reduce((acc, item) => {
        return acc + item.offset;
      }, 0) / this.samples.length;

    const precision = NtpTimeSync.stdDev(this.samples.map((sample) => sample.offset));

    lastResult = {
      offset: offset,
      precision: precision,
    };
    lastPoll = Date.now();

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

  private static pad(string: string, length: number, char = "0", side: "left" | "right" = "left") {
    if (side === "left") {
      return char.repeat(length).substring(0, length - string.length) + string;
    }

    return string + char.repeat(length).substring(0, length - string.length);
  }

  /**
   * @param {Integer} leapIndicator, defaults to 3 (unsynchronized)
   * @param {Integer} ntpVersion, defaults to `options.ntpDefaults.version`
   * @param {Integer} mode, defaults to 3 (client)
   * @return {Buffer}
   */
  private createPacket(leapIndicator = 3, ntpVersion: number = null, mode = 3): Buffer {
    ntpVersion = ntpVersion || this._options.ntpDefaults.version;

    // generate NTP packet
    let ntpData = new Array(48).fill(0);

    ntpData[0] =
      // Leap indicator (= 3, unsynchronized)
      NtpTimeSync.pad((leapIndicator >>> 0).toString(2), 2) +
      // NTP version (= 4)
      NtpTimeSync.pad((ntpVersion >>> 0).toString(2), 3) +
      // client mode (= 3)
      NtpTimeSync.pad((mode >>> 0).toString(2), 3);

    ntpData[0] = parseInt(ntpData[0], 2);

    // origin timestamp
    const baseTime = new Date().getTime() - this._options.ntpDefaults.referenceDate.getTime();
    const seconds = baseTime / 1000;
    let ntpTimestamp = (seconds * Math.pow(2, 32)).toString(2);
    ntpTimestamp = NtpTimeSync.pad(ntpTimestamp, 64);

    // origin timestamp
    ntpData[24] = parseInt(ntpTimestamp.substr(0, 8), 2);
    ntpData[25] = parseInt(ntpTimestamp.substr(8, 8), 2);
    ntpData[26] = parseInt(ntpTimestamp.substr(16, 8), 2);
    ntpData[27] = parseInt(ntpTimestamp.substr(24, 8), 2);
    ntpData[28] = parseInt(ntpTimestamp.substr(32, 8), 2);
    ntpData[29] = parseInt(ntpTimestamp.substr(40, 8), 2);
    ntpData[30] = parseInt(ntpTimestamp.substr(48, 8), 2);
    ntpData[31] = parseInt(ntpTimestamp.substr(56, 8), 2);

    // transmit timestamp
    ntpData[40] = parseInt(ntpTimestamp.substr(0, 8), 2);
    ntpData[41] = parseInt(ntpTimestamp.substr(8, 8), 2);
    ntpData[42] = parseInt(ntpTimestamp.substr(16, 8), 2);
    ntpData[43] = parseInt(ntpTimestamp.substr(24, 8), 2);
    ntpData[44] = parseInt(ntpTimestamp.substr(32, 8), 2);
    ntpData[45] = parseInt(ntpTimestamp.substr(40, 8), 2);
    ntpData[46] = parseInt(ntpTimestamp.substr(48, 8), 2);
    ntpData[47] = parseInt(ntpTimestamp.substr(56, 8), 2);

    return Buffer.from(ntpData);
  }

  private static cleanup(client: dgram.Socket) {
    debug("Cleaning up socket");

    try {
      client.close();
    } catch (e) {
      // ignore, as we just want to cleanup
    }
  }

  getNetworkTime(server: string, port = 123): Promise<NtpReceivedPacket> {
    debug("Getting network time from %s:%s", server, port);

    return new Promise((resolve, reject) => {
      const client = dgram.createSocket("udp4");
      let hasFinished = false;

      const errorCallback = (err: Error) => {
        debug("Error while getting network time from %s:%d: %s", server, port, err.message);

        if (timeoutHandler) {
          clearTimeout(timeoutHandler);
          timeoutHandler = null;
        }

        if (hasFinished) {
          debug("Discarding error, as request has already finished.");
          return;
        }

        NtpTimeSync.cleanup(client);

        hasFinished = true;
        reject(err);
      };

      client.on("error", (err) => errorCallback);

      // setup timeout
      let timeoutHandler = setTimeout(() => {
        errorCallback(new Error("Timeout waiting for NTP response."));
      }, this._options.replyTimeout);

      client.send(this.createPacket(), port, server, (err) => {
        if (hasFinished) {
          debug("Discarding connection, as request has already finished.");
          return;
        }

        if (err) {
          errorCallback(err);
          return;
        }

        client.once("message", function (msg) {
          if (hasFinished) {
            debug("Discarding response, as request has already finished.");
            return;
          }

          clearTimeout(timeoutHandler);
          timeoutHandler = null;
          client.close();

          const result: NtpReceivedPacket = {
            ...NtpPacketParser.parse(msg),
            destinationTimestamp: new Date(),
          };

          debug("Received response: %O", result);

          hasFinished = true;
          resolve(result);
        });
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
    if (data.version > this._options.ntpDefaults.version) {
      throw new Error("Format error: Expected version " + this._options.ntpDefaults.version + ", got " + data.version);
    }

    /*
     * A stratum error occurs if (1) the server has never been
     * synchronized, (2) the server stratum is invalid.
     */
    if (data.leapIndicator === 3 || data.stratum >= this._options.ntpDefaults.maxStratum) {
      throw new Error("Stratum error: Remote clock is unsynchronized");
    }

    /*
     * Verify valid root distance.
     */
    const rootDelay = (data.rootDelay.getTime() - this._options.ntpDefaults.referenceDate.getTime()) / 1000;
    const rootDispersion = (data.rootDispersion.getTime() - this._options.ntpDefaults.referenceDate.getTime()) / 1000;
    if (rootDelay / 2 + rootDispersion >= this._options.ntpDefaults.maxDispersion) {
      throw new Error("Distance error: Root distance too large");
    }

    /*
     * Verify origin timestamp
     */
    if (data.originTimestamp.getTime() > new Date().getTime()) {
      throw new Error("Format error: Origin timestamp is from the future");
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
