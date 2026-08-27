---
name: project-youtube-ffmpeg-orphan-process-bugfix
description: "YouTube channel deletion left yt-dlp's internal ffmpeg downloader running forever (Linux child-reparenting race) — fixed 2026-07-28; general lesson about process-tree cleanup ordering"
metadata: 
  node_type: memory
  type: project
  originSessionId: b3c8c8ff-973b-46d2-b12c-190f0dae72df
  modified: 2026-07-30T03:44:32.054Z
---

**Symptom reported**: user observed 2 ffmpeg processes for a single YouTube channel, and deleting the channel didn't kill one of them (it survived as an orphan, `ppid=1`).

**Root cause**: `youtubeStreamService.js`'s `_stopEntry()` used to send `SIGTERM` to the tracked `ytdlpProcess`, **await its own `close` event**, and only then run `pgrep -P <ytdlpPid>` to find and kill yt-dlp's internal `ffmpeg` downloader subprocess (yt-dlp spawns this itself for HLS-live sources and for muxing separate DASH video+audio streams — a grandchild Node never holds a direct handle to). Linux reparents an orphaned child to `init` **the instant its parent exits** — well before the parent is even reaped/waited-on, i.e. before Node's `close` event fires. So by the time the `pgrep -P` scan ran, the grandchild's `ppid` had already changed and the scan found nothing — the internal ffmpeg leaked forever on every explicit delete. Confirmed live: reproduced with a real test channel (`https://www.youtube.com/watch?v=kkVrj2cr9Ko`), deleted it, and the internal ffmpeg PID survived reparented to init. Also found a pre-existing orphan from this same bug still running against the live "EarthCam Live: Dublin, Ireland" channel from an earlier session.

**Fix**: capture child PIDs (`findChildPids()`, new helper using `pgrep -P`) **before** signaling the parent at all — while it's still guaranteed alive — then kill those captured PIDs afterward instead of re-deriving them from a parent that may already be dead. Applied to both teardown paths: `_stopEntry()` (explicit delete, `stopAll()` on server shutdown) and the natural-restart path (`ffProc.on('close')`, triggered by 403-URL-expiry or network-hiccup restarts — actually the more frequent trigger in production than explicit deletes).

**How to apply**: this is a general pattern, not YouTube-specific — **any code that walks a process tree to clean up descendants must enumerate those descendants before touching the parent, never after waiting for the parent to exit.** If a similar "orphaned child survives cleanup" bug shows up elsewhere in this codebase (e.g. any future `spawn()` call whose child itself spawns further processes), check whether the cleanup code makes this same ordering mistake first.

**Regression test**: `test/api/youtube_streams.test.js` TC-D-005b — creates a real stream, confirms an internal ffmpeg exists (`pgrep -f ffmpeg.*<videoId>`), deletes it, waits past both grace periods (3s+5s), asserts zero matching processes remain. Requires a real yt-dlp/ffmpeg + internet access (same live-integration-test pattern as the rest of that file).

**Docs updated same session**: `docs/design/Design_YouTube_RTSP_Ingest.md` §10.2 note + `Design_LTS2026_YouTube_RTSP_Ingest.md` §6 (corrected `_stopEntry()` pseudocode), `docs/srs/SRS_YouTube_RTSP_Ingest.md` FR-YT-068, `docs/srs/SRS_LTS2026_YouTube_RTSP_Ingest.md` FR-YT2-062, `docs/tc/TC_YouTube_RTSP_Ingest.md` TC-D-005b, `.claude/skills/camera-stream-setup/SKILL.md` (+ `.github` mirror), `docs/ops/Process_Management.md`.
