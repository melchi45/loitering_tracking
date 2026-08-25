import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import '@melchi45/rtsp-over-websocket';
import { RTSPOverWebSocketPlayState } from '@melchi45/rtsp-over-websocket';
import { useAuthStore } from '../stores/authStore';
import type { Camera } from '../types';

type Props = {
  camera: Camera;
  // Forwards the raw payload of <rtsp-over-websocket>'s 'statistics'
  // CustomEvent up to CameraView.tsx, which owns the RTSP-over-WebSocket stats badge/toggle/
  // panel (same pattern as useWebRTC's iceStats/rxHistory) so it can sit in
  // the same top-right corner flex column as the WebRTC/Zone rows instead of
  // a second, overlapping absolutely-positioned block. See useRTSPOverWebSocketStats.ts.
  onStatistics?: (raw: unknown) => void;
};

// RTSPOverWebSocketElement is the subset of the custom element's instance API
// this component calls directly. mute()/unmute()/ismute are purely local —
// they flip a client-side flag (MediaRouter's private `_mute`, default true)
// and drive VideoTagPlayer's `<video>.muted`, not a network round-trip to the
// camera (confirmed against the package's source) — same effect as WebRTC's
// local mute below, just reached through the element's own API instead of a
// DOM property. All three throw RTSPOverWebSocketError if called before the
// element has an attached player (i.e. before playback actually starts).
interface RTSPOverWebSocketElement extends HTMLElement {
  play: () => void;
  mute: () => boolean;
  unmute: () => boolean;
  readonly ismute: boolean;
}

/**
 * Renders a camera via `@melchi45/rtsp-over-websocket`'s `<rtsp-over-websocket>`
 * custom element — RTSP-over-WebSocket, the 3rd streaming mode alongside
 * JPEG/WebRTC. See docs/design/Design_RTSP_Over_WebSocket.md.
 *
 * 2026-08-04: switched from the git submodule (`submodules/rtsp-over-websocket`,
 * ~70 sequentially-loaded legacy `<script>` tags registering the old
 * `<rtsp-over-websocket>` element) to this npm package — the same author's TypeScript
 * rewrite of the same component (`submodules/rtsp-over-websocket`'s `src/player/`),
 * now published standalone. Verified against the package's source
 * (github.com/melchi45/rtsp-over-websocket) before switching: same
 * `observedAttributes` set (hostname/proxy/port/secure/device/channel/
 * profile_number/username/password/width/height), same `channel` semantics
 * (1-based in markup, 0-based on the wire — `channelSlot + 1` below is
 * unchanged), same `device === 'nvr'` branch, same event names (`error`/
 * `statechange`/`waiting`/`statistics`/`meta`), and a public `play()` method
 * — so the attribute/event wiring below carries over unchanged from the old
 * `<rtsp-over-websocket>` version; only the loading mechanism (npm import vs. a
 * sequential global-script loader) and the `PLAYING` state constant (now a
 * proper named export instead of a `window.UmpPlayState` global) changed.
 * The package's own React wrapper (`@melchi45/rtsp-over-websocket`'s
 * `src/player/react/Player.tsx`) is intentionally NOT used — it drives
 * playback through `SunapiManager.init()`, which has the browser log into
 * the device's own SUNAPI REST API directly. This project's architecture
 * never lets the browser talk to a camera directly: credentials come from
 * our own JWT-gated `/api/cameras/:id/rtsp-over-websocket-credentials`, and `hostname`/
 * `proxy` always point back at this same origin (Proxy mode, see the design
 * doc) — the raw custom element used below is the only way to keep that
 * intact.
 *
 * Playback is started with an explicit `.play()` call rather than the
 * `autoplay` attribute — the element's own `connectedCallback()` only
 * auto-plays when `_autoplay && (_profile || _profile_number) && _deviceType`
 * are all already set at connect time (a timing-sensitive attribute race).
 */
export default function RTSPOverWebSocketView({ camera, onStatistics }: Props) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshAccessToken = useAuthStore((s) => s.refresh);
  const [scriptReady, setScriptReady] = useState(false);
  const [creds, setCreds] = useState<{ username: string; password: string } | null>(null);
  const [error, setError] = useState('');
  // Runtime notices from the mounted <rtsp-over-websocket> element (e.g. "SPS
  // payload not available yet", "video element not found yet") — unlike
  // `error` above, these do NOT unmount the player. The element's own error
  // dispatch sends these through the exact same 'error' CustomEvent as
  // genuinely fatal failures (no special case for them in its internal
  // switch, so they fall to the `default:` branch), but they are expected,
  // self-recovering conditions during the RTSP handshake window — the
  // vendor's own reference example just logs them and keeps the player
  // running, which is what lets it recover a few frames later. Unmounting on
  // the first one permanently killed the session before it ever got the
  // chance to recover (carried over from the old <rtsp-over-websocket> integration,
  // 2026-07-24 — see git history for the original incident).
  const [playerNotice, setPlayerNotice] = useState('');
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // Mirrors CameraView.tsx's WebRTC mute button (same default, same icons,
  // same corner) — see the RTSPOverWebSocketElement interface comment above
  // for why `default: true` matches the package's own internal default.
  // `isPlaying` gates the button's visibility the same way WebRTC gates on
  // `webrtcState === 'connected'`: mute()/unmute()/ismute all throw before
  // the element has an attached player, and 'statechange' → PLAYING is the
  // first point that's guaranteed true.
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  // WebRTC's mute button is gated on a real `hasAudio` flag from the SDP
  // (useWebRTC.ts) — this package has no equivalent pre-check. `ismute()`/
  // `mute()`/`unmute()` all throw RTSPOverWebSocketError (0x0303, "The
  // current profile is not support audio in") when the RTSP session has no
  // audio RTP session, and there's no separate cheap query for that — the
  // throw itself IS the only "does this profile have audio" signal the
  // package exposes (confirmed against StreamPlayer.ts's isMute()/
  // controlAudioIn(), both guarded by the identical `checkRtpSession('audio')`
  // check). So `hasAudio` here is learned reactively from that first probe
  // rather than known upfront — default false (hidden) until proven true,
  // same fail-closed posture as WebRTC's button just for a different reason.
  const [hasAudio, setHasAudio] = useState(false);
  const elementRef = useRef<RTSPOverWebSocketElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Client-side floor on how often 'meta' relays to the server — a busy
  // metadata track (e.g. thermal BoxTemperatureReading, sent on every RTP
  // packet) would otherwise fire one POST per packet. The server's own
  // per-camera+topic+state dedup (onvifParser.js's ingestOnvifEvents) already
  // absorbs unchanged-state repeats into a no-op DB write, so this is purely
  // a request-rate safety valve, not a correctness requirement.
  const lastMetaRelayRef = useRef(0);

  // <rtsp-over-websocket> requires explicit numeric width/height attributes —
  // omitting them leaves the element unable to render anything at all, even
  // once scripts/credentials are otherwise ready. Track the tile's actual
  // rendered size so it isn't hardcoded.
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

  // The `import '@melchi45/rtsp-over-websocket'` side effect at module load
  // registers the custom element synchronously (no network round-trip like
  // the old sequential <script>-tag loader), but `customElements.whenDefined`
  // is still the correct signal to wait on rather than assuming it's ready
  // immediately — it resolves on the same tick either way.
  useEffect(() => {
    let cancelled = false;
    customElements.whenDefined('rtsp-over-websocket')
      .then(() => { if (!cancelled) setScriptReady(true); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load RTSP-over-WebSocket player'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // authStore proactively refreshes the access token shortly before it
    // expires (see authStore.ts's scheduleTokenRefresh), but a session that
    // was asleep/backgrounded past that point (e.g. a laptop lid closed
    // through the refresh window) can still hand this fetch a stale token —
    // retry once with a freshly refreshed one instead of surfacing "Invalid
    // or expired token" for what's really just a timer that got skipped.
    const fetchCredentials = async (token: string | null, alreadyRetried: boolean): Promise<unknown> => {
      const res = await fetch(`/api/cameras/${camera.id}/rtsp-over-websocket-credentials`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 401 && !alreadyRetried) {
        const refreshed = await refreshAccessToken();
        if (refreshed) return fetchCredentials(useAuthStore.getState().accessToken, true);
      }
      return res.json();
    };

    fetchCredentials(accessToken, false)
      .then((raw) => {
        if (cancelled) return;
        const d = raw as { success?: boolean; data?: { username: string; password: string }; error?: string };
        if (d.success && d.data) setCreds(d.data);
        else setError(d.error || 'Failed to load RTSP-over-WebSocket credentials');
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load RTSP-over-WebSocket credentials'); });
    return () => { cancelled = true; };
  }, [camera.id, accessToken, refreshAccessToken]);

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
      setPlayerNotice(typeof detail?.message === 'string' ? detail.message : 'RTSP-over-WebSocket player reported an error');
    };
    const onStateChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.readyState === RTSPOverWebSocketPlayState.PLAYING) {
        setPlayerNotice('');
        setIsPlaying(true);
        // Doubles as the hasAudio probe (see the hasAudio state comment) —
        // succeeds only when this profile has an audio RTP session, and also
        // syncs isMuted from the element's own getter rather than assuming
        // our `true` default held.
        try {
          setIsMuted(el.ismute);
          setHasAudio(true);
        } catch (err) {
          // Expected on a video-only profile (0x0303 "not support audio
          // in") — but logged rather than fully silent (same console.warn
          // convention as useWebRTC.ts), so a genuinely unexpected failure
          // here (vs. "this camera has no audio") is distinguishable in
          // devtools instead of just "button never appears, no clue why".
          console.warn(`[RTSPOverWebSocketView][${camera.id.slice(0, 8)}] hasAudio probe failed — hiding mute button:`, err);
          setHasAudio(false);
        }
      }
    };
    // Fired by the element itself from inside mute()/unmute() (see the
    // RTSPOverWebSocketElement interface comment) — dispatched synchronously,
    // so this is also how handleToggleMute below learns the new state rather
    // than trusting mute()/unmute()'s own (inconsistently-signed) return value.
    const onChangeMute = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail?.status === 'boolean') setIsMuted(detail.status);
    };
    // 'waiting' is dispatched by the same error-switch as 'error' (see the
    // playerNotice comment above), just split into its own CustomEvent —
    // same transient, self-recovering category, so it shares playerNotice
    // instead of a second banner. detail.waiting is `waiting.islost`: true
    // while packets are being lost, false on the matching recovery tick.
    const onWaiting = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.waiting === true) {
        setPlayerNotice(`${detail.media || 'stream'} packet loss — recovering…`);
      } else if (detail?.waiting === false) {
        setPlayerNotice('');
      }
    };
    // 'statistics' fires ~1/sec regardless of the (unused here) `statistics`
    // attribute — that attribute only gates the element's own built-in
    // overlay DOM elements, not the event dispatch itself.
    const onStatisticsEvent = (e: Event) => {
      onStatistics?.((e as CustomEvent).detail?.statistics);
    };
    // 'meta' carries the RTSP session's own metadata track (ONVIF
    // MetadataStream XML — motion/analytics events, the same class of data
    // server/src/services/onvifParser.js already parses from ingest-daemon's
    // Application RTP fan-out for JPEG/WebRTC-mode cameras). RTSP-over-WebSocket
    // mode bypasses ingest-daemon entirely (Design_RTSP_Over_WebSocket.md §8.13),
    // so for an RTSP-over-WebSocket-only camera (webrtcEnabled=false) this browser-side event
    // is otherwise the only place that XML ever surfaces — relay it to the
    // server so it lands in the same onvif_events timeline/Socket.IO stream
    // as every other camera.
    const onMeta = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const xml = detail?.xml;
      if (typeof xml !== 'string' || xml.length === 0) return;
      const now = Date.now();
      if (now - lastMetaRelayRef.current < 500) return;
      lastMetaRelayRef.current = now;
      fetch(`/api/cameras/${camera.id}/rtsp-over-websocket-meta`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ xml }),
      }).catch(() => { /* best-effort relay — never block playback on a failed POST */ });
    };
    el.addEventListener('error', onError);
    el.addEventListener('statechange', onStateChange);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('statistics', onStatisticsEvent);
    el.addEventListener('meta', onMeta);
    el.addEventListener('changemute', onChangeMute);
    try {
      el.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start RTSP-over-WebSocket playback');
    }
    return () => {
      el.removeEventListener('error', onError);
      el.removeEventListener('statechange', onStateChange);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('statistics', onStatisticsEvent);
      el.removeEventListener('meta', onMeta);
      el.removeEventListener('changemute', onChangeMute);
      setIsPlaying(false);
      setHasAudio(false);
    };
  }, [scriptReady, creds, camera.id, onStatistics, accessToken]);

  // Mirrors CameraView.tsx's WebRTC mute button handler — toggle based on
  // current UI state, then let the 'changemute' listener above (fired
  // synchronously from inside mute()/unmute()) reconcile the real state.
  const handleToggleMute = () => {
    const el = elementRef.current;
    if (!el) return;
    try {
      if (isMuted) el.unmute(); else el.mute();
    } catch (err) {
      // Same 0x0303 "no audio RTP session" throw as the hasAudio probe above
      // (or the player-not-attached race) — hide the button rather than
      // leave a click silently do nothing.
      console.warn(`[RTSPOverWebSocketView][${camera.id.slice(0, 8)}] mute()/unmute() failed — hiding button:`, err);
      setHasAudio(false);
    }
  };

  if (camera.channelSlot == null) {
    return (
      <div className="flex items-center justify-center w-full h-full text-xs text-red-400 text-center px-4">
        RTSP-over-WebSocket playback requires a Channel Slot
      </div>
    );
  }

  const secure = window.location.protocol === 'https:';

  return (
    <div ref={containerRef} className="relative w-full h-full">
      {error ? (
        <div className="flex items-center justify-center w-full h-full text-xs text-red-400 text-center px-4">
          RTSP-over-WebSocket playback error: {error}
        </div>
      ) : !scriptReady || !creds || !size ? (
        <div className="flex items-center justify-center w-full h-full text-xs text-gray-500">
          Loading RTSP-over-WebSocket player…
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
          {/* device="nvr" (not "camera") lets `channel` select our synthetic
              per-camera RTSP path; profile_number is mandatory in nvr mode.
              width/height are required for the element to render at all (see
              the ResizeObserver effect above for why). */}
          <rtsp-over-websocket
            key={camera.id}
            ref={elementRef as React.Ref<HTMLElement>}
            id={`rtsp-over-websocket-${camera.id}`}
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
            device="nvr"
            // Element treats `channel` as 1-based and subtracts 1 internally to
            // build the outgoing RTSP path — confirmed against this package's
            // own source (RTSPOverWebSocket.ts generateRTSPURL()).
            // rtspOverWebSocketServer.js matches that resulting channel number
            // directly against camera.channelSlot (exact equality, server/src/
            // services/rtspOverWebSocketServer.js), so passing channelSlot unmodified
            // here would silently connect to channelSlot-1's camera instead.
            channel={String(camera.channelSlot + 1)}
            profile_number="1"
            username={creds.username}
            password={creds.password}
            width={String(size.width)}
            height={String(size.height)}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
          {/* Audio mute/unmute button — same position/icons/gating pattern as
              CameraView.tsx's WebRTC button (webrtcState === 'connected' &&
              hasAudio); isPlaying is the RTSP-over-WebSocket equivalent of "connected", and
              hasAudio here is learned reactively (see its state comment)
              rather than known upfront. */}
          {isPlaying && hasAudio && (
            <button
              onClick={handleToggleMute}
              title={isMuted ? 'Unmute audio' : 'Mute audio'}
              className="absolute bottom-2 left-2 z-10 flex items-center justify-center w-7 h-7 rounded-full bg-black/50 hover:bg-black/75 text-white transition-colors"
            >
              {isMuted
                ? <VolumeX className="w-4 h-4" />
                : <Volume2 className="w-4 h-4 text-blue-300" />}
            </button>
          )}
        </>
      )}
    </div>
  );
}
