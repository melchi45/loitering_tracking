/**
 * SUNAPI/Wisenet-style RTSP channel path substitution.
 *
 * Shared by DiscoveredCameraPanel.tsx (Add flow) and CameraEditModal.tsx
 * (Edit-flow NVR channel switch fallback) — see docs/design/Design_Camera_Discovery.md.
 *
 * Pure string regex substitution — no protocol/vendor detection. Recognizes
 * two conventions observed on real devices in this deployment:
 *   - `/profileN/` (1-based) — WiseNet Profile S encoders (e.g. TID-A800,
 *     rtsp://ip:port/profile1/media.smp)
 *   - `/N/H.264/` (0-based channel segment right after the host) — the
 *     majority of cameras/NVRs on this network
 *     (rtsp://ip/0/H.264/media.smp, rtsp://ip/1/H.264/media.smp, ...)
 * `channel` is always 1-based at the call site regardless of which
 * convention the URL uses — only the second pattern needs a -1 translation
 * when writing it into the URL. For a URL that matches neither shape, this
 * is a silent no-op — callers should treat an unchanged return value as
 * "could not resolve".
 */
export function channelRtspUrl(baseUrl: string, channel: number): string {
  if (!baseUrl) return baseUrl;
  if (/\/profile\d+\//i.test(baseUrl)) return baseUrl.replace(/\/profile\d+\//i, `/profile${channel}/`);
  if (/\/profile\d+$/i.test(baseUrl))  return baseUrl.replace(/\/profile\d+$/i,  `/profile${channel}`);
  if (/\/\d+\/H\.264\//i.test(baseUrl)) return baseUrl.replace(/\/\d+\/H\.264\//i, `/${channel - 1}/H.264/`);
  return baseUrl;
}

/**
 * Default RTSP URL guess when nothing else is known about a SUNAPI device
 * (no baseUrl to pattern-match against — e.g. Add-flow probing a bare IP
 * before any credentials/discovery data are available). Uses the `/N/
 * H.264/media.smp` (0-based channel) convention, since that's what the
 * majority of real SUNAPI devices on this network actually serve.
 * `rtspPort` should be the CGI-confirmed port (probe-channels'
 * `sunapiRtspPort`) when available; falls back to the SUNAPI default of 554
 * otherwise.
 */
export function defaultSunapiRtspUrl(ip: string, rtspPort?: number | null, channel = 1): string {
  return `rtsp://${ip}:${rtspPort || 554}/${channel - 1}/H.264/media.smp`;
}
