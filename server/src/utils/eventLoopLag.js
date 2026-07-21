'use strict';

// Event loop lag monitor (2026-07-21, §diagnose-sync-disconnects) — added to
// investigate WebRTC sessions for completely unrelated cameras/streams
// closing within milliseconds of each other, repeatedly, despite mediasoup
// Producer/Consumer scores staying healthy and aggregate host CPU staying
// mostly idle (mpstat confirmed ~85% idle at the time). A single blocked
// Node.js event loop tick would delay ICE/DTLS timer callbacks for every
// active WebRtcTransport at once — exactly the "all streams die together"
// signature observed — regardless of how much idle CPU other cores have,
// since Node's main thread is single-threaded. This samples actual elapsed
// time between ticks against the expected interval; anything over
// LAG_WARN_MS past that expectation means something blocked the loop
// synchronously for that long.
const CHECK_INTERVAL_MS = 500;
const LAG_WARN_MS       = 200;

function startEventLoopLagMonitor() {
  let last = Date.now();
  setInterval(() => {
    const now  = Date.now();
    const lag  = now - last - CHECK_INTERVAL_MS;
    last = now;
    if (lag > LAG_WARN_MS) {
      console.warn(`[EventLoopLag] main thread blocked for ~${lag}ms (expected ${CHECK_INTERVAL_MS}ms tick)`);
    }
  }, CHECK_INTERVAL_MS).unref();
}

module.exports = { startEventLoopLagMonitor };
