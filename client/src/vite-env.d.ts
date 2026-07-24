/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Build-time constants injected via vite.config.ts `define` — the server's
// actual configured HTTPS_PORT/HTTP_PORT (server/.env), read at Vite config
// eval time. See UmpPlayerView.tsx for why these exist (window.location.port
// fallback, not just a hardcoded 443/80 guess).
declare const __LTS_HTTPS_PORT__: string;
declare const __LTS_HTTP_PORT__: string;

// @melchi45/ump-player registers <ump-player> as a native custom element via a
// dynamically-loaded <script> (see client/src/components/UmpPlayerView.tsx) —
// it has no React type definitions of its own, so declare its attributes here.
declare namespace JSX {
  interface IntrinsicElements {
    'ump-player': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      hostname?: string;
      proxy?: string;
      port?: string;
      secure?: string;
      device?: string;
      channel?: string;
      profile_number?: string;
      username?: string;
      password?: string;
      autoplay?: string;
      width?: string;
      height?: string;
    };
  }
}
