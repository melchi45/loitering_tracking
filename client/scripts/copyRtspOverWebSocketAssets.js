#!/usr/bin/env node
// Copies the WASM/JS sidecar files that @melchi45/rtsp-over-websocket's Web Workers load at
// runtime via a *relative* `new URL('../foo.wasm', self.location.href)` from their own
// dist/player/ directory. Vite's static-asset analysis only follows `new URL(..., import.meta.url)`
// references inside the module graph it bundles — it never re-parses the CONTENT of the
// package's own pre-built worker chunk files, so these siblings are invisible to it and never
// get copied into dist/assets on `vite build`. Each referencing worker resolves the path one
// level up from wherever it itself ends up served (/assets/<worker>.js -> /<file>), so the
// targets below must land at the site root, i.e. client/public/ (not public/assets/).
// See vite.config.ts's assetsInlineLimit comment and RTSPOverWebSocketView.tsx for the
// broader Invalid-URL bug this is paired with.
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '../node_modules/@melchi45/rtsp-over-websocket/dist/player');
const DEST_DIR = path.resolve(__dirname, '../public');

// decoderWorker -> ffmpeg.{js,wasm}; audiotranscoderWorker -> ffmpegAAC.transcoder.{js,wasm};
// zipWorker -> minizip-asm.js (confirmed via grep against each worker's own `new URL(...)` call).
const REQUIRED_FILES = [
  'ffmpeg.js',
  'ffmpeg.wasm',
  'ffmpegAAC.transcoder.js',
  'ffmpegAAC.transcoder.wasm',
  'minizip-asm.js',
];

for (const file of REQUIRED_FILES) {
  const src = path.join(SRC_DIR, file);
  const dest = path.join(DEST_DIR, file);
  if (!fs.existsSync(src)) {
    console.error(`[copyRtspOverWebSocketAssets] MISSING in package: ${src}`);
    process.exitCode = 1;
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log(`[copyRtspOverWebSocketAssets] copied ${file}`);
}
