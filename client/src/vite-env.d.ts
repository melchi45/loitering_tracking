/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Build-time constants injected via vite.config.ts `define` — the server's
// actual configured HTTPS_PORT/HTTP_PORT (server/.env), read at Vite config
// eval time. See RTSPOverWebSocketView.tsx for why these exist (window.location.port
// fallback, not just a hardcoded 443/80 guess).
declare const __LTS_HTTPS_PORT__: string;
declare const __LTS_HTTP_PORT__: string;

// The package ships no .d.ts of its own (dist/player/*.js only) — TS would
// otherwise fall back to implicit `any` for everything imported from it
// (tsc error TS7016). Declare just the shape RTSPOverWebSocketView.tsx actually
// imports, matching the package's real source
// (src/player/elements/RTSPOverWebSocketTypes.ts — a plain `as const` object,
// not a TS enum) rather than a blanket `declare module '...';`.
declare module '@melchi45/rtsp-over-websocket' {
  export const RTSPOverWebSocketPlayState: {
    readonly STOPPED: 0;
    readonly PLAYING: 1;
    readonly PAUSED: 2;
    readonly STEP: 3;
  };
}

// @melchi45/rtsp-over-websocket registers <rtsp-over-websocket> as a native
// custom element via its side-effect import (see
// client/src/components/RTSPOverWebSocketView.tsx) — the package ships its own React
// wrapper with JSX types, but we don't import that wrapper (see
// RTSPOverWebSocketView.tsx's module docstring for why), so declare the element's
// attributes here ourselves instead.
declare namespace JSX {
  interface IntrinsicElements {
    'rtsp-over-websocket': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      hostname?: string;
      proxy?: string;
      port?: string;
      secure?: string;
      https?: string;
      device?: string;
      channel?: string;
      profile?: string;
      profile_number?: string;
      username?: string;
      password?: string;
      autoplay?: string;
      width?: string;
      height?: string;
    };
  }
}
