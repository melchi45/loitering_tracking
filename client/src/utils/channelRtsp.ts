/**
 * SUNAPI/Wisenet-style RTSP channel path substitution.
 *
 * Shared by DiscoveredCameraPanel.tsx (Add flow) and CameraEditModal.tsx
 * (Edit-flow NVR channel switch fallback) — see docs/design/Design_Channel_Slot.md §5.6.
 *
 * Pure string regex substitution — no protocol/vendor detection. Only fires
 * when the base URL already contains a `/profileN/` (or trailing `/profileN`)
 * segment, the SUNAPI/Wisenet convention (e.g. rtsp://ip:554/profile1/media.smp).
 * For a URL that doesn't match this shape, this is a silent no-op — callers
 * should treat an unchanged return value as "could not resolve".
 */
export function channelRtspUrl(baseUrl: string, channel: number): string {
  if (!baseUrl) return baseUrl;
  if (/\/profile\d+\//i.test(baseUrl)) return baseUrl.replace(/\/profile\d+\//i, `/profile${channel}/`);
  if (/\/profile\d+$/i.test(baseUrl))  return baseUrl.replace(/\/profile\d+$/i,  `/profile${channel}`);
  return baseUrl;
}
