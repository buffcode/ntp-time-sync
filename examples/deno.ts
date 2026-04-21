// Example: using ntp-time-sync with Deno
// Run: deno run --allow-net examples/deno.ts
import { NtpTimeSync } from "npm:ntp-time-sync";

const timeSync = NtpTimeSync.getInstance();

console.log("system time", new Date());
const result = await timeSync.getTime();
console.log("ntp time", result.now);
console.log("offset (ms)", result.offset);
console.log("precision (ms)", result.precision);
