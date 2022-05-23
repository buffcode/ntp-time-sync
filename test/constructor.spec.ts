/*jshint mocha*/
import { NtpTimeSync, NtpTimeSyncDefaultOptions } from "../src";

const assert = require("assert");

describe("NTP options", function () {
    it("should run without giving any options", async function () {
        this.timeout(4000);

        const instance = new NtpTimeSync();

        const result = await instance.getTime();
        assert.ok("now" in result);
    });

    it("should run with the default options given explicitly", async function () {
        this.timeout(4000);

        const instance = new NtpTimeSync(NtpTimeSyncDefaultOptions);

        const result = await instance.getTime();
        assert.ok("now" in result);
    });

    it("should imply default port 123", async function () {
        const instance = new NtpTimeSync({
            servers: ["0.pool.ntp.org"],
        });

        assert.strictEqual(instance.options.servers[0].port, 123);
    });

    it("should use given server port", async function () {
        const instance = new NtpTimeSync({
            servers: ["0.pool.ntp.org:54321"],
        });

        assert.strictEqual(instance.options.servers[0].port, 54321);
    });

    it("should return a singleton", async function () {
        const singleton1 = NtpTimeSync.getInstance();
        const singleton2 = NtpTimeSync.getInstance();

        assert.strictEqual(singleton1, singleton2);
    });

    it("should return a new instance", async function () {
        const singleton = NtpTimeSync.getInstance();
        const instance = new NtpTimeSync();

        assert.notStrictEqual(instance, singleton);
    });

    it("should fail when NTP is not reachable", async function () {
        this.timeout(40000);

        const instance = new NtpTimeSync({
            servers: ["ntp.invalid"],
        });

        await assert.rejects(instance.getTime(true));
    });
});
