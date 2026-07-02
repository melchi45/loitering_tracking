'use strict';

/**
 * SUNAPI/Wisenet-style RTSP channel path substitution.
 *
 * Server-side twin of client/src/utils/channelRtsp.ts — keep both in sync.
 * Used by POST /api/cameras/probe-channels to synthesize per-channel RTSP
 * URLs for SUNAPI devices where only a single base rtspUrl is known.
 *
 * Pure string regex substitution — no protocol/vendor detection. Only fires
 * when the base URL already contains a `/profileN/` (or trailing `/profileN`)
 * segment, the SUNAPI/Wisenet convention (e.g. rtsp://ip:554/profile1/media.smp).
 * Returns the input unchanged if the shape doesn't match (caller should treat
 * an unchanged return value as "could not resolve").
 */
function channelRtspUrl(baseUrl, channel) {
  if (!baseUrl) return baseUrl;
  if (/\/profile\d+\//i.test(baseUrl)) return baseUrl.replace(/\/profile\d+\//i, `/profile${channel}/`);
  if (/\/profile\d+$/i.test(baseUrl))  return baseUrl.replace(/\/profile\d+$/i,  `/profile${channel}`);
  return baseUrl;
}

module.exports = { channelRtspUrl };
