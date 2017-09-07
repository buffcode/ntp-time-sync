import NtpTimeSync from "./src/index";

(async function() {
  const ntpInstance1 = new NtpTimeSync();
  const ntpInstance2 = new NtpTimeSync();

  console.log("system time", new Date());
  console.log("real time when called", await ntpInstance1.now());
  console.log("real time when finished", (await ntpInstance2.getTime()).now);
})();