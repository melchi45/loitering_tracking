---
name: project-ump-missing-bbox-canvas-bugfix
description: "UMP playback mode never showed detection bounding boxes — CameraView.tsx's UMP branch was missing the <canvas> element entirely, fixed 2026-07-30"
metadata: 
  node_type: memory
  type: project
  originSessionId: b3c8c8ff-973b-46d2-b12c-190f0dae72df
  modified: 2026-08-10T04:03:13.441Z
---

**Naming update (2026-08-10):** "UMP Player" was renamed to "RTSP-over-WebSocket" throughout the codebase — `<UmpPlayerView>` is now `<RTSPOverWebSocketView>` (`client/src/components/RTSPOverWebSocketView.tsx`), `streamingMode='ump'` is now `streamingMode='rtsp-over-websocket'`, and the doc filenames in the "Docs updated" line below were already `Design_RTSP_Over_WebSocket.md`/`SRS_RTSP_Over_WebSocket.md`/`TC_RTSP_Over_WebSocket.md` even at the time this fix shipped (this memory's doc names predate that rename and were never corrected). The underlying bug/fix described below is still current — `CameraView.tsx`'s RTSP-over-WebSocket branch does render a `<canvas>` today.

**Symptom reported**: with a camera's `streamingMode='rtsp-over-websocket'`, ingest-daemon → analysis capture image delivery was confirmed working (AI inference running normally), but the Streaming Dashboard's `<rtsp-over-websocket>` video showed no detection bounding box overlay at all.

**Root cause**: `client/src/components/CameraView.tsx` renders three mutually-exclusive branches depending on `streamingMode` (`rtsp-over-websocket` / `webrtc` / `jpeg`, fallback no-signal placeholder). The WebRTC branch renders `<video ref={videoRef}>` + `<canvas ref={canvasRef}>`; the JPEG branch renders `<img ref={imgRef}>` + `<canvas ref={canvasRef}>`. The **RTSP-over-WebSocket branch only rendered `<RTSPOverWebSocketView>` plus badge/stats UI — no `<canvas>` at all**. The `useEffect` that calls `drawOverlay()` (keyed on `detections`/`zones`/`hasVideo`/`frameWidth`/`frameHeight`) ran correctly regardless of streaming mode — Socket.IO `frame`/`detections` subscription in `useCamera.ts` has no `streamingMode` gating — but the effect's own guard (`if (!canvas || !hasVideo) return;`) silently no-op'd every single time because `canvasRef.current` was permanently `null` for RTSP-over-WebSocket-mode tiles.

**Why this was easy to miss**: all the data plumbing (frame reception, detection reception, `frameWidth`/`frameHeight`) was working identically across all three modes — the bug was purely "the DOM element the draw call targets was never mounted for this one branch." No error was thrown; the effect just returned early every time.

**Fix**: added `<canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />` to the RTSP-over-WebSocket branch, positioned right after `<RTSPOverWebSocketView>` (so it stacks below the `z-10` badge/stats UI, matching the WebRTC/JPEG branches' pattern). `drawOverlay()` scales via `canvas.clientWidth/clientHeight` (CSS size) against `frameWidth`/`frameHeight` from `useCamera()` — the same AI-frame-resolution values used by every mode — so no RTSP-over-WebSocket-specific native-resolution data (`<rtsp-over-websocket>`'s own `'resize'`/`'statistics'` CustomEvents) was needed for this fix.

**General lesson**: when a UI feature works in some rendering branches but not others despite identical upstream data flow, check whether the "sink" element (canvas/video/etc.) actually exists in the DOM for the broken branch before suspecting the data pipeline — an early-return guard on a null ref can make a completely broken render path look like a silent data problem.

**Docs updated**: `docs/design/Design_RTSP_Over_WebSocket.md` §8.20 (v3.5), `docs/srs/SRS_RTSP_Over_WebSocket.md` new FR-UMP-043 (v1.1), `docs/tc/TC_RTSP_Over_WebSocket.md` new TC-UMP-043 (v1.1), `.claude/skills/camera-stream-setup/SKILL.md` (+ `.github` mirror).

**Not yet live-tested**: this fix was verified via code-logic tracing + `tsc --noEmit`/`vite build` only — no real camera was available to confirm visually in a browser during the session that made this fix. If a user reports it's still not working after this fix, check browser DevTools for whether the new `<canvas>` element actually mounts as a sibling of `<rtsp-over-websocket>` in that DOM subtree.
