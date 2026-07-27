#!/usr/bin/env node
'use strict';

/**
 * Symlinks the static assets <ump-player> needs at runtime into public/,
 * where Vite serves them verbatim from the site root — required because
 * several of these scripts spawn Web Workers with paths hardcoded relative
 * to the page root (e.g. `./media/ump/Worker/...`), not resolvable via a
 * normal JS import/bundle.
 *
 * 2026-07-23: switched from the published @melchi45/ump-player npm package
 * (dist/@melchi45/ump-player.min.js, a minified bundle) to this repo's own
 * submodules/ump-player checkout, on branch `feature/lts-server-integration`
 * — after the npm bundle's shipped build repeatedly crashed on real H.265
 * cameras (see docs/design/Design_UMP_Player_RTSP_over_WebSocket.md §8.9)
 * and could not be debugged past minification.
 *
 * 2026-07-24: switched from copying files to symlinking them, so edits made
 * directly in submodules/ump-player are picked up on browser refresh alone
 * (no rerun needed) while iterating on the vendor source. Runs as a
 * "postinstall" script so a fresh `npm install` (re-)creates the links.
 *
 * The whole app/media/ump/ tree is linked entry-by-entry (not just the files
 * the demo html happens to load) so any internal cross-file reference
 * resolves the same way it does for the vendor's own reference example
 * (app/ump-player-example.html) — except Custom/ump-player.js, which is
 * linked to the newer src/ump/custom/ump-player.js instead (the actively-
 * developed source; app/media/ump/Custom/ump-player.js is an older snapshot
 * of the same file, per user instruction to use the src/ version). Because
 * only that one file needs overriding, `ump/` itself is a real directory
 * containing per-entry symlinks rather than a single symlink to app/media/ump
 * — a single directory symlink would make the override impossible without
 * writing into the submodule's own tracked file.
 */

const fs = require('fs');
const path = require('path');

const SUBMODULE_ROOT = path.resolve(__dirname, '..', '..', 'submodules', 'ump-player');
const WISENET_ROOT = path.resolve(__dirname, '..', '..', 'submodules', 'WiseNetChromeIPInstaller');
const PUBLIC_ROOT = path.resolve(__dirname, '..', 'public');
const APP_MEDIA = path.join(SUBMODULE_ROOT, 'app', 'media');
const UMP_CUSTOM_OVERRIDE = path.join(SUBMODULE_ROOT, 'src', 'ump', 'custom', 'ump-player.js');

function ensureSymlink(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.lstatSync(dest);
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    // dest doesn't exist yet — nothing to remove
  }
  const target = path.relative(path.dirname(dest), src);
  const type = fs.statSync(src).isDirectory() ? 'dir' : 'file';
  fs.symlinkSync(target, dest, type);
  console.log(`[copyUmpPlayerAssets] linked ${path.relative(SUBMODULE_ROOT, src)} -> ${path.relative(PUBLIC_ROOT, dest)}`);
}

if (!fs.existsSync(SUBMODULE_ROOT) || fs.readdirSync(SUBMODULE_ROOT).length === 0) {
  // submodules/ump-player needs `git submodule update --init` first — a
  // fresh checkout without that should not fail `npm install` entirely.
  console.warn('[copyUmpPlayerAssets] submodules/ump-player not initialized — skipping (UMP streaming mode will be unavailable until `git submodule update --init` is run).');
  process.exit(0);
}

// app/media/ — link every top-level entry (angularInterface, ump, ...)
// individually so descending into `ump/` can special-case Custom/ below.
for (const entry of fs.readdirSync(APP_MEDIA)) {
  if (entry === '.git') continue; // nested submodule's own git-link file, not a runtime asset
  if (entry === 'ump') continue; // handled below (needs the Custom/ override)
  ensureSymlink(path.join(APP_MEDIA, entry), path.join(PUBLIC_ROOT, 'media', entry));
}

// app/media/ump/ — same per-entry linking, except Custom/, which gets its
// own real directory so ump-player.js can be overridden without touching
// the submodule's own tracked copy.
const UMP_DIR = path.join(APP_MEDIA, 'ump');
if (fs.existsSync(UMP_DIR)) {
  for (const entry of fs.readdirSync(UMP_DIR)) {
    if (entry === 'Custom') continue;
    ensureSymlink(path.join(UMP_DIR, entry), path.join(PUBLIC_ROOT, 'media', 'ump', entry));
  }
  if (fs.existsSync(UMP_CUSTOM_OVERRIDE)) {
    ensureSymlink(UMP_CUSTOM_OVERRIDE, path.join(PUBLIC_ROOT, 'media', 'ump', 'Custom', 'ump-player.js'));
  } else {
    console.warn(`[copyUmpPlayerAssets] missing expected path: ${UMP_CUSTOM_OVERRIDE} — skipping`);
  }
} else {
  console.warn(`[copyUmpPlayerAssets] missing expected path: ${UMP_DIR} — skipping`);
}

// External libs the reference example loads before the ump/ tree — vendored
// exact versions (CryptoJS v3.1.2, not npm's newer crypto-js) rather than
// npm packages, matching what the reference example actually runs against.
const EXTERNAL_LIBS = [
  { from: path.join(SUBMODULE_ROOT, 'app', 'external-lib', 'util', 'crypto.js'), to: path.join(PUBLIC_ROOT, 'ump-player', 'crypto.js') },
  { from: path.join(SUBMODULE_ROOT, 'app', 'external-lib', 'util', 'sylvester.js'), to: path.join(PUBLIC_ROOT, 'ump-player', 'sylvester.js') },
  { from: path.join(SUBMODULE_ROOT, 'app', 'external-lib', 'util', 'glUtils.js'), to: path.join(PUBLIC_ROOT, 'ump-player', 'glUtils.js') },
  { from: path.join(SUBMODULE_ROOT, 'app', 'external-lib', 'log4javascript', 'log4javascript.js'), to: path.join(PUBLIC_ROOT, 'ump-player', 'log4javascript.js') },
  // ump-player's own reference example loads this from external-lib/fast-xml-parser/
  // (commented-out CDN fallback in app/ump-player-example.html — the local file
  // doesn't exist in this checkout at all) to populate `window.parser`, which
  // Util/metaDataParser.js requires before it will ever set meta.json — and
  // ump-player.js's onUmpMeta() only dispatches the public 'meta' CustomEvent
  // once BOTH meta.json and meta.xml are set. Without this, 'meta' silently
  // never fires. Reused verbatim from the sibling WiseNetChromeIPInstaller
  // submodule (same vendor family, same exact fast-xml-parser build) rather
  // than adding an npm dependency, matching this project's existing policy of
  // vendoring the exact version the reference example actually runs against.
  { from: path.join(WISENET_ROOT, 'external-lib', 'fast-xml-parser', 'parser.min.js'), to: path.join(PUBLIC_ROOT, 'ump-player', 'parser.min.js') },
];

for (const { from, to } of EXTERNAL_LIBS) {
  if (!fs.existsSync(from)) {
    console.warn(`[copyUmpPlayerAssets] missing expected path: ${from} — skipping`);
    continue;
  }
  ensureSymlink(from, to);
}
