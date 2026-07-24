import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import type { Camera } from '../types';

type Props = {
  camera: Camera;
};

// UmpPlayerElement is the subset of the custom element's instance API this
// component calls directly — ump-player ships no TS types of its own.
interface UmpPlayerElement extends HTMLElement {
  play: () => void;
}

// ump-player.js declares `var UmpPlayState = {...}` as a top-level classic
// script (loaded via a plain <script> tag, not an ES module — see
// loadScript() below), so it lands on `window`. Used to recognize the
// "recovered/playing" signal in the 'statechange' listener below.
declare global {
  interface Window {
    UmpPlayState?: { PLAYING?: number };
  }
}

// 2026-07-23: switched from the published @melchi45/ump-player npm package
// (a single minified bundle) to this repo's submodules/ump-player checkout,
// on branch `feature/lts-server-integration` — the npm bundle repeatedly
// crashed on real H.265 cameras and, being minified, could not be debugged
// past a stack trace (see docs/design/Design_UMP_Player_RTSP_over_WebSocket.md
// §8.9). This loads the exact same (unminified) script set, in the exact same
// order, as the vendor's own reference example
// (submodules/ump-player/app/ump-player-example.html's <head>), copied
// verbatim into public/ by client/scripts/copyUmpPlayerAssets.js — except the
// last entry, which is intentionally overwritten with the newer src/ump/
// custom/ump-player.js (the actively-developed source; app/media/ump/Custom/
// ump-player.js is an older snapshot of the same file).
const UMP_PLAYER_SCRIPTS = [
  // External libs the reference example loads first — vendored exact
  // versions (e.g. CryptoJS v3.1.2, not npm's newer crypto-js) rather than
  // npm packages, so this matches what the reference example actually runs.
  '/ump-player/log4javascript.js',
  '/ump-player/crypto.js',
  '/ump-player/sylvester.js',
  '/ump-player/glUtils.js',
  // util.js assigns `window.log` (used by every other ump/ file's own
  // top-level `log.getLogger(...)` call, confirmed live 2026-07-23:
  // "Cannot read properties of undefined (reading 'getLogger')" at
  // streamManager.js) — it loads much later in the reference example's own
  // <head> (after Interface/streamManager.js etc.), which only "works" there
  // because those scripts carry the `async` attribute and the browser is
  // free to execute them in whatever order their downloads finish, not
  // strict document order. This loader is intentionally deterministic
  // (sequential, not async), so util.js must move up to right after the
  // external libs — before anything that references `window.log` at load
  // time, which in practice means before every other ump/ file.
  '/media/ump/Util/util.js',
  // Core session/network/util/decoder/player modules, in the reference
  // example's own dependency order.
  '/media/ump/MediaSession/mediaRouter.js',
  '/media/ump/MediaSession/TextSession/metaSession.js',
  '/media/ump/MediaSession/session.js',
  '/media/ump/MediaSession/rtcpSession.js',
  '/media/ump/MediaSession/rtpSession.js',
  '/media/ump/MediaSession/rtpClient.js',
  '/media/ump/MediaSession/VideoSession/bufferStatus.js',
  '/media/ump/MediaSession/VideoSession/videoBuffer.js',
  '/media/ump/MediaSession/VideoSession/playbackBufferManager.js',
  '/media/ump/MediaSession/VideoSession/h264Session.js',
  '/media/ump/MediaSession/VideoSession/h265Session.js',
  '/media/ump/MediaSession/VideoSession/mjpegSession.js',
  '/media/ump/MediaSession/AudioSession/aacSession.js',
  '/media/ump/MediaSession/AudioSession/g711Session.js',
  '/media/ump/MediaSession/AudioSession/g726Session.js',
  '/media/ump/MediaSession/AudioSession/audioTalkSession.js',
  '/media/ump/Network/RTSPoverWebsocket/rtspClient.js',
  '/media/ump/Network/RTSPoverWebsocket/rtspClientManager.js',
  '/media/ump/Network/rtspStatusCode.js',
  '/media/ump/Network/websocketStatusCode.js',
  '/media/ump/Network/transport/transport.js',
  '/media/ump/Interface/streamManager.js',
  '/media/ump/Interface/streamPlayer.js',
  '/media/ump/Util/fishEye3D_multi.js',
  '/media/ump/Util/mp4Generator.js',
  '/media/ump/Util/audioUtil.js',
  '/media/ump/Util/digestGenerator.js',
  '/media/ump/Util/metaDataParser.js',
  '/media/ump/Util/videoDigitalPTZ.js',
  '/media/ump/Util/h264SPSParser.js',
  '/media/ump/Util/h265SPSParser.js',
  '/media/ump/Util/hashMap.js',
  '/media/ump/Util/Queue.js',
  '/media/ump/Util/CircularTypedArrayQueue.js',
  '/media/ump/Listen/Renderer/audioPlayer.js',
  '/media/ump/Listen/Renderer/audioPlayerAAC.js',
  '/media/ump/Listen/Renderer/audioPlayerGxx.js',
  '/media/ump/Listen/Decoder/audioDecoder.js',
  '/media/ump/Listen/Decoder/audioDecoderG711.js',
  '/media/ump/Listen/Decoder/audioDecoderG726x.js',
  '/media/ump/Listen/Decoder/audioDecoderG726_16.js',
  '/media/ump/Listen/Decoder/audioDecoderG726_24.js',
  '/media/ump/Listen/Decoder/audioDecoderG726_32.js',
  '/media/ump/Listen/Decoder/audioDecoderG726_40.js',
  '/media/ump/Listen/Decoder/audioDecoderAAC.js',
  '/media/ump/Listen/Decoder/ffmpegAAC.js',
  '/media/ump/Talk/Talk.js',
  '/media/ump/Talk/Encoder/audioEncoderG711.js',
  '/media/ump/Video/Player/videoPlayer.js',
  '/media/ump/Video/Player/Canvas/canvasTagPlayer.js',
  '/media/ump/Video/Player/Canvas/canvasRenderer.js',
  '/media/ump/Video/Player/Canvas/webglCanvas.js',
  '/media/ump/Video/Player/Canvas/stepBufferList.js',
  '/media/ump/Video/Player/Video/videoTagPlayer.js',
  '/media/ump/Backup/backupProvider.js',
  '/media/ump/Backup/FileMaker.js',
  '/media/ump/Exception/umpError.js',
  '/media/ump/Exception/RTSPError.js',
  '/media/ump/Exception/AuthError.js',
  '/media/ump/Exception/SunapiError.js',
  '/media/ump/Exception/RTCPError.js',
  '/media/ump/Network/http/sunapiRestClient.js',
  '/media/ump/Network/http/sunapiManager.js',
  '/media/ump/Network/http/httpStatusCode.js',
  '/media/ump/Network/http/sunapiClient.js',
  // The custom element itself — MUST load last (registers customElements.define).
  // Served from /media/ump/Custom/ump-player.js, but copyUmpPlayerAssets.js
  // overwrites that file's content with submodules/ump-player's src/ump/custom/
  // ump-player.js (see module docstring above).
  '/media/ump/Custom/ump-player.js',
];

// Module-level singleton so the whole script set only loads once no matter
// how many camera tiles use UMP mode at once.
let scriptLoadPromise: Promise<void> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false; // preserve load order relative to siblings appended after it
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function loadUmpPlayerScript(): Promise<void> {
  if (!scriptLoadPromise) {
    scriptLoadPromise = customElements.get('ump-player')
      ? Promise.resolve()
      : UMP_PLAYER_SCRIPTS.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve());
  }
  return scriptLoadPromise;
}

/**
 * Renders a camera via UMP Player RTSP-over-WebSocket (3rd streaming mode,
 * alongside JPEG/WebRTC) — see docs/design/Design_UMP_Player_RTSP_over_WebSocket.md.
 *
 * `proxy`/`hostname` both point at this same origin (Proxy mode, §4 of the
 * design doc) — the browser never talks to the camera directly. The RTSP
 * Digest credentials come from a dedicated, JWT-gated endpoint
 * (`GET /api/cameras/:id/ump-credentials`) since the normal camera endpoints
 * deliberately strip `password`.
 *
 * Playback is started with an explicit `.play()` call rather than the
 * `autoplay` attribute — the bundled component's own connectedCallback()
 * only auto-plays when `_autoplay && (_profile || _profile_number) &&
 * _deviceType` are all already set at connect time (a timing-sensitive
 * attribute race), and the package's own app/*.html examples all drive
 * playback via an explicit `.play()` call instead of relying on it.
 */
export default function UmpPlayerView({ camera }: Props) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [scriptReady, setScriptReady] = useState(false);
  const [creds, setCreds] = useState<{ username: string; password: string } | null>(null);
  const [error, setError] = useState('');
  // Runtime notices from the mounted <ump-player> element (e.g. "SPS payload
  // not available yet", "video element not found yet") — unlike `error`
  // above, these do NOT unmount the player. ump-player.js's own onUmpError()
  // dispatches these through the exact same 'error' CustomEvent as genuinely
  // fatal failures (its internal switch has no special case for them, so
  // they fall to the `default:` branch), but they are expected, self-
  // recovering conditions during the RTSP handshake window — the vendor's
  // own reference example just logs them and keeps the player running,
  // which is what lets it recover a few frames later. Unmounting on the
  // first one (the previous behavior here) permanently killed the session
  // before it ever got the chance to recover (2026-07-24, confirmed via
  // onUmpError()'s switch: neither SPS-not-available (0x0304) nor
  // video-element-missing (0x0900) — both raised on mediaRouter.js's side,
  // not ump-player.js's — has its own case, so both fall to `default:`
  // alongside truly transient conditions).
  const [playerNotice, setPlayerNotice] = useState('');
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const elementRef = useRef<UmpPlayerElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // <ump-player> requires explicit numeric width/height attributes — per the
  // package's own JSDoc ("width of HTML element {optional, but element can
  // not be display}"), omitting them leaves the element unable to render
  // anything at all, even once scripts/credentials are otherwise ready.
  // Track the tile's actual rendered size so it isn't hardcoded.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0 && box.height > 0) {
        setSize({ width: Math.round(box.width), height: Math.round(box.height) });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadUmpPlayerScript()
      .then(() => customElements.whenDefined('ump-player'))
      .then(() => { if (!cancelled) setScriptReady(true); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load UMP player'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/cameras/${camera.id}/ump-credentials`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.success) setCreds(d.data);
        else setError(d.error || 'Failed to load UMP credentials');
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load UMP credentials'); });
    return () => { cancelled = true; };
  }, [camera.id, accessToken]);

  // Explicit play() + surface the element's own 'error' CustomEvent (dispatched
  // by e.g. auth/connection failures, but also by expected transient startup
  // conditions — see the playerNotice comment above) as a non-blocking notice,
  // and clear it once 'statechange' reports the player actually reached
  // PLAYING — mirrors how the vendor's own reference example treats these:
  // logged, not fatal.
  useEffect(() => {
    if (!scriptReady || !creds) return;
    const el = elementRef.current;
    if (!el) return;
    const onError = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setPlayerNotice(typeof detail?.message === 'string' ? detail.message : 'UMP player reported an error');
    };
    const onStateChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (window.UmpPlayState && detail?.readyState === window.UmpPlayState.PLAYING) {
        setPlayerNotice('');
      }
    };
    el.addEventListener('error', onError);
    el.addEventListener('statechange', onStateChange);
    try {
      el.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start UMP playback');
    }
    return () => {
      el.removeEventListener('error', onError);
      el.removeEventListener('statechange', onStateChange);
    };
  }, [scriptReady, creds, camera.id]);

  if (camera.channelSlot == null) {
    return (
      <div className="flex items-center justify-center w-full h-full text-xs text-red-400 text-center px-4">
        UMP playback requires a Channel Slot
      </div>
    );
  }

  const secure = window.location.protocol === 'https:';

  return (
    <div ref={containerRef} className="relative w-full h-full">
      {error ? (
        <div className="flex items-center justify-center w-full h-full text-xs text-red-400 text-center px-4">
          UMP playback error: {error}
        </div>
      ) : !scriptReady || !creds || !size ? (
        <div className="flex items-center justify-center w-full h-full text-xs text-gray-500">
          Loading UMP player…
        </div>
      ) : (
        <>
          {/* Non-blocking — the player element below stays mounted and keeps
              retrying underneath; see the playerNotice state comment above. */}
          {playerNotice && (
            <div className="absolute top-0 left-0 right-0 z-10 bg-yellow-900/80 text-yellow-200 text-[10px] px-2 py-1 truncate">
              {playerNotice}
            </div>
          )}
          {/* device="nvr" (not "camera") — matches the shipped, working example
              (dist/html/ump-player-play.html) and lets `channel` select our
              synthetic per-camera RTSP path; profile_number is mandatory in nvr
              mode. width/height are required for the element to render at all
              (see the ResizeObserver effect above for why). */}
          <ump-player
            key={camera.id}
            ref={elementRef as React.Ref<HTMLElement>}
            id={`ump-player-${camera.id}`}
            hostname={window.location.hostname}
            proxy={window.location.hostname}
            // window.location.port is empty only when this page itself was served
            // on the protocol-default port (443/80) — e.g. behind a reverse proxy
            // terminating there. In that case the *externally visible* port really
            // is 443/80 (same-origin WS should still target that), but as a same-
            // origin fallback we use this deployment's actual configured port
            // (server/.env HTTPS_PORT/HTTP_PORT, injected via vite.config.ts
            // `define`) rather than hardcoding the generic web-standard 443/80,
            // since this project's real defaults are 3443/3080.
            port={window.location.port || (secure ? __LTS_HTTPS_PORT__ : __LTS_HTTP_PORT__)}
            secure={secure ? 'true' : 'false'}
            // This page is always served BY the LTS server itself (see
            // hostname/proxy above), never by the device being connected to
            // — so the /StreamingServer WS address must never derive a path
            // suffix from window.location.pathname (streamPlayer.js's
            // open()/startStreaming()). Currently harmless only because this
            // view happens to always render at "/", but any future nested
            // route would reproduce the bug fixed in app-react's App.tsx
            // (a bogus "/StreamingServer/<route>" suffix). See
            // docs/design/Design_UMP_Player_RTSP_over_WebSocket.md.
            // use_pathname="false"
            device="nvr"
            // ump-player's NVR mode treats `channel` as 1-based and subtracts 1
            // internally to build the outgoing RTSP path (ump-player.js:626-627,
            // `strRtspURL += this._channel`) — confirmed 2026-07-23 via the
            // standalone reference example, which needed channel="7" to reach
            // channelSlot=6. umpStreamingServer.js matches that resulting
            // channel number directly against camera.channelSlot (exact
            // equality, server/src/services/umpStreamingServer.js), so passing
            // channelSlot unmodified here silently connects to channelSlot-1's
            // camera instead.
            channel={String(camera.channelSlot + 1)}
            profile_number="1"
            username={creds.username}
            password={creds.password}
            width={String(size.width)}
            height={String(size.height)}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </>
      )}
    </div>
  );
}
