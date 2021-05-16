const NtpTimeSync = require("../dist/index").NtpTimeSync;

(async function() {
  const ntpInstance1 = NtpTimeSync.getInstance();
  const ntpInstance2 = NtpTimeSync.getInstance();

  console.log("is singleton?", ntpInstance1 === ntpInstance2);

  console.log("system time", new Date());
  console.log("ntp time when called", await ntpInstance1.now());
  console.log("ntp time when finished", (await ntpInstance2.getTime()).now);
})();
