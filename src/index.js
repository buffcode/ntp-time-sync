"use strict";

/**
 * @typedef {Object} NtpTimeResult
 * @property {Date} now Correct real time
 * @property {Number} offset Offset local to real time in milliseconds
 * @property {Number} precision Precision in milliseconds
 */

const dgram = require("dgram");
import NtpPacketParser from "ntp-packet-parser";

let singleton;
let lastPoll;
let lastResult;

export default class NtpTimeSync {
  /**
   * @param {Object} options
   */
  constructor(options = undefined) {
    const defaultOptions = {
      // list of NTP time servers, optionally including a port (defaults to options.ntpDefaults.port = 123)
      servers: [
        "0.pool.ntp.org",
        "1.pool.ntp.org",
        "2.pool.ntp.org",
        "3.pool.ntp.org"
      ],

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
        referenceDate: new Date("Jan 01 1900 GMT")
      }
    };

    this.options = {
      ...defaultOptions,
      ...options
    };

    // convert servers to internal representation
    this.options.servers = this.options.servers.map(server => {
      return {
        host: server.split(":", 2)[0],
        port: Number(server.split(":", 2)[1]) || this.options.ntpDefaults.port
      };
    });

    this.samples = [];
  }

  /**
   * Returns a singleton
   * @param {Object} options
   * @return {NtpTimeSync}
   */
  static getInstance(options = undefined) {
    if (!singleton) {
      singleton = new NtpTimeSync(options);
    }

    return singleton;
  }

  async collectSamples(numSamples) {
    let ntpResults = [];
    let retry = 0;

    do {
      let timePromises = [];

      this.options.servers.forEach(server => {
        timePromises.push(
          this.getNetworkTime(server.host, server.port).then(data => {
            this.acceptResponse(data);

            return data;
          })
        );
      });

      // wait for NTP responses to arrive
      ntpResults = ntpResults
        .concat(await Promise.all(timePromises.map(p => p.catch(e => e))))
        .filter(function(result) {
          return !(result instanceof Error);
        });

      if (ntpResults.length === 0) {
        retry++;
      }
    } while (ntpResults.length < numSamples && retry < 3);

    if (ntpResults.length === 0) {
      throw new Error(
        "Connection error: Unable to get any NTP response after " +
          retry +
          " retries"
      );
    }

    // filter erroneous responses, use valid ones as samples
    let samples = [];
    ntpResults.forEach(data => {
      const offsetSign =
        data.transmitTimestamp.getTime() > data.destinationTimestamp.getTime()
          ? 1
          : -1;

      const offset =
        (Math.abs(
          data.receiveTimestamp.getTime() - data.originTimestamp.getTime()
        ) +
          Math.abs(
            data.transmitTimestamp.getTime() -
              data.destinationTimestamp.getTime()
          )) /
        2 *
        offsetSign;

      const delay = Math.max(
        data.destinationTimestamp.getTime() -
          data.originTimestamp.getTime() -
          (data.receiveTimestamp.getTime() - data.transmitTimestamp.getTime()),
        Math.pow(2, this.options.ntpDefaults.precision)
      );

      const dispersion =
        Math.pow(2, data.precision) +
        Math.pow(2, this.options.ntpDefaults.precision) +
        this.options.ntpDefaults.tolerance *
          (data.destinationTimestamp.getTime() -
            data.originTimestamp.getTime());

      samples.push({
        data: data,
        offset: offset,
        delay: delay,
        dispersion: dispersion
      });
    });

    // sort samples by ascending delay
    samples.sort(function(a, b) {
      return a.delay - b.delay;
    });

    // restrict to best n samples
    return samples.slice(0, numSamples);
  }

  /**
   * @param {Boolean} force Force NTP update
   * @return {NtpTimeResult}
   */
  async getTime(force = false) {
    if (
      !force &&
      lastPoll &&
      Date.now() - lastPoll <
        Math.pow(2, this.options.ntpDefaults.minPoll) * 1000
    ) {
      let date = new Date();
      date.setUTCMilliseconds(date.getUTCMilliseconds() + lastResult.offset);

      return {
        now: date,
        offset: lastResult.offset,
        precision: lastResult.precision
      };
    }

    // update time samples
    this.samples = await this.collectSamples(this.options.sampleCount);

    // calculate offset
    const offset =
      this.samples.reduce((acc, item) => {
        return acc + item.offset;
      }, 0) / this.samples.length;

    const precision = NtpTimeSync.stdDev(
      this.samples.map(sample => sample.offset)
    );

    lastResult = {
      offset: offset,
      precision: precision
    };
    lastPoll = Date.now();

    let date = new Date();
    date.setUTCMilliseconds(date.getUTCMilliseconds() + offset);

    return {
      now: date,
      offset: offset,
      precision: precision
    };
  }

  /**
   * Will return the correct timestamp when function was called
   * @param {Boolean} force
   * @return {Date}
   */
  async now(force = false) {
    const now = new Date();
    const result = await this.getTime(force);

    now.setUTCMilliseconds(now.getUTCMilliseconds() + result.offset);
    return now;
  }

  /**
   * @param {String} string
   * @param {Integer} length
   * @param {String} char
   * @param {String} side
   * @private
   */
  static pad(string, length, char = "0", side = "left") {
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
   * @private
   */
  createPacket(leapIndicator = 3, ntpVersion = null, mode = 3) {
    ntpVersion = ntpVersion || this.options.ntpDefaults.version;

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
    const baseTime =
      new Date().getTime() - this.options.ntpDefaults.referenceDate.getTime();
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

  /**
   *
   * @param client
   * @private
   */
  static cleanup(client) {
    try {
      client.close();
    } catch (e) {
      // ignore, as we just want to cleanup
    }
  }

  /**
   * @param {String} server
   * @param {Integer} port
   * @return {Promise|NTPPacket}
   */
  getNetworkTime(server, port = 123) {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket("udp4");
      let hasFinished = false;

      const errorCallback = err => {
        if (timeoutHandler) {
          clearTimeout(timeoutHandler);
          timeoutHandler = null;
        }

        if (hasFinished) {
          return;
        }

        NtpTimeSync.cleanup(client);

        hasFinished = true;
        reject(err);
      };

      client.on("error", err => errorCallback);

      // setup timeout
      let timeoutHandler = setTimeout(() => {
        errorCallback(new Error("Timeout waiting for NTP response."));
      }, this.options.replyTimeout);

      client.send(this.createPacket(), port, server, err => {
        if (hasFinished) {
          return;
        }

        if (err) {
          errorCallback(err);
          return;
        }

        client.once("message", function(msg) {
          if (hasFinished) {
            return;
          }

          clearTimeout(timeoutHandler);
          timeoutHandler = null;
          client.close();

          let result = NtpPacketParser.parse(msg);
          result.destinationTimestamp = new Date();

          hasFinished = true;
          resolve(result);
        });
      });
    });
  }

  /**
   * Test if response is acceptable for synchronization
   * @param {NTPPacket} data
   */
  acceptResponse(data) {
    /*
     * Format error
     */
    if (data.version > this.options.ntpDefaults.version) {
      throw new Error(
        "Format error: Expected version " +
          this.options.ntpDefaults.version +
          ", got " +
          data.version
      );
    }

    /*
     * A stratum error occurs if (1) the server has never been
     * synchronized, (2) the server stratum is invalid.
     */
    if (
      data.leapIndicator === 3 ||
      data.stratum >= this.options.ntpDefaults.maxStratum
    ) {
      throw new Error("Stratum error: Remote clock is unsynchronized");
    }

    /*
     * Verify valid root distance.
     */
    const rootDelay =
      (data.rootDelay.getTime() -
        this.options.ntpDefaults.referenceDate.getTime()) /
      1000;
    const rootDispersion =
      (data.rootDispersion.getTime() -
        this.options.ntpDefaults.referenceDate.getTime()) /
      1000;
    if (
      rootDelay / 2 + rootDispersion >=
      this.options.ntpDefaults.maxDispersion
    ) {
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
   * @param {Array} values
   * @return {number}
   * @private
   */
  static avg(values) {
    const sum = values.reduce(function(sum, value) {
      return sum + value;
    }, 0);

    return sum / values.length;
  }

  /**
   * Standard deviation for a list of numbers
   * @param {Array} values
   * @return {number}
   * @private
   */
  static stdDev(values) {
    const avg = this.avg(values);

    const squareDiffs = values.map(function(value) {
      const diff = value - avg;
      return diff * diff;
    });

    return Math.sqrt(this.avg(squareDiffs));
  }
}
