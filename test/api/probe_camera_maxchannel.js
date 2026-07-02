'use strict';
/**
 * Live camera MaxChannel probe — SUNAPI + ONVIF, against a real device.
 *
 * Diagnostic script, NOT part of the automated TC-ID suite (tc_runner_cli.js) —
 * it requires an actual reachable camera on the network, unlike the rest of
 * test/api/*.test.js which exercise the LTS server's own logic. Mirrors the
 * exact detection path `POST /api/cameras/probe-channels` uses in production
 * (server/src/api/cameras.js §4.6) by requiring the same two service
 * functions directly — no server/DB needs to be running.
 *
 * Usage:
 *   node test/api/probe_camera_maxchannel.js --ip 192.168.214.32 \
 *     --username admin --password '<password>' [--http-port 80] [--https] \
 *     [--onvif-port 80] [--onvif-https-port 443] [--rtsp rtsp://192.168.214.32:554/profile1/media.smp]
 *
 * ONVIF is probed on both HTTP (--onvif-port, default 80) and HTTPS
 * (--onvif-https-port, default 443) in parallel via enrichDeviceAutoScheme() —
 * a device's SUNAPI and ONVIF services do not always agree on scheme even on
 * the same box (observed live: 192.168.214.37's SUNAPI CGI is HTTPS-only via
 * an nginx redirect, but its ONVIF service answers on plain HTTP).
 *
 * Credentials are never hardcoded here (CLAUDE.md 보안 규칙) — pass them via
 * --username/--password or the PROBE_CAMERA_USERNAME/PROBE_CAMERA_PASSWORD
 * env vars. Nothing is written to the repo/log with the password value.
 */

const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'https') { out.https = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const ip         = args.ip       || process.env.PROBE_CAMERA_IP;
const username   = args.username || process.env.PROBE_CAMERA_USERNAME || '';
const password   = args.password || process.env.PROBE_CAMERA_PASSWORD || '';
const httpPort   = parseInt(args['http-port'] || process.env.PROBE_CAMERA_HTTP_PORT || '', 10) || undefined;
const httpType   = !!(args.https || process.env.PROBE_CAMERA_HTTPS);
const onvifPort      = parseInt(args['onvif-port'] || process.env.PROBE_CAMERA_ONVIF_PORT || '', 10) || 80;
const onvifHttpsPort = parseInt(args['onvif-https-port'] || process.env.PROBE_CAMERA_ONVIF_HTTPS_PORT || '', 10) || 443;
const baseRtsp   = args.rtsp || process.env.PROBE_CAMERA_RTSP || null;
const timeoutMs  = parseInt(args.timeout || '', 10) || 8000;

if (!ip) {
  console.error('Usage: node test/api/probe_camera_maxchannel.js --ip <ip> --username <user> --password <pass> [--http-port N] [--https] [--onvif-port N] [--rtsp <baseRtspUrl>]');
  console.error('(or set PROBE_CAMERA_IP / PROBE_CAMERA_USERNAME / PROBE_CAMERA_PASSWORD env vars)');
  process.exit(1);
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

(async () => {
  let querySunapiMaxChannel, enrichDeviceAutoScheme, channelRtspUrl;
  try {
    ({ querySunapiMaxChannel } = require(path.join('..', '..', 'server', 'src', 'services', 'discoveryService')));
    ({ enrichDeviceAutoScheme } = require(path.join('..', '..', 'server', 'src', 'services', 'onvifDiscovery')));
    ({ channelRtspUrl } = require(path.join('..', '..', 'server', 'src', 'utils', 'channelRtsp')));
  } catch (err) {
    console.error(`Could not load server modules (run from repo root): ${err.message}`);
    process.exit(1);
  }

  console.log(`=== Live MaxChannel Probe — ${ip} ===`);
  console.log(`auth=${username && password ? 'yes' : 'no'} httpPort=${httpPort || '(default)'} httpType=${httpType ? 'https' : 'http'} onvifPort=${onvifPort} onvifHttpsPort=${onvifHttpsPort} timeoutMs=${timeoutMs}`);
  console.log('');

  const [sunapiMax, onvifResult] = await Promise.all([
    withTimeout(
      querySunapiMaxChannel(ip, httpPort, httpType, timeoutMs / 2, username, password),
      timeoutMs,
      1,
    ),
    withTimeout(
      enrichDeviceAutoScheme(ip, { onvifPort, onvifHttpsPort }),
      timeoutMs,
      null,
    ),
  ]);

  const onvifMax      = onvifResult?.MaxChannel || 1;
  const onvifProfiles = (onvifResult?.profiles || []).filter((p) => p.rtspUrl);

  console.log('── SUNAPI (GET /stw-cgi/attributes.cgi/attributes) ──');
  console.log(`  MaxChannel: ${sunapiMax}`);
  if (baseRtsp && sunapiMax > 1) {
    console.log('  Synthesized per-channel RTSP URLs (path substitution):');
    for (let ch = 1; ch <= sunapiMax; ch++) {
      console.log(`    CH${ch}: ${channelRtspUrl(baseRtsp, ch)}`);
    }
  }
  console.log('');

  console.log('── ONVIF (GetProfiles/GetStreamUri) ──');
  if (!onvifResult) {
    console.log('  No response / timed out');
  } else {
    console.log(`  Manufacturer: ${onvifResult.Manufacturer || '(unknown)'}  Model: ${onvifResult.Model || '(unknown)'}`);
    console.log(`  MaxChannel: ${onvifMax}  (profiles total=${onvifResult.profiles.length}, with resolved RTSP URI=${onvifProfiles.length})`);
    for (const p of onvifProfiles) {
      console.log(`    CH${p.channelIndex} [${p.name}] ${p.encoding} ${p.width}x${p.height}@${p.fps}fps → ${p.rtspUrl}`);
    }
  }
  console.log('');

  // Same decision rule as POST /api/cameras/probe-channels (server/src/api/cameras.js §4.6)
  let protocol = 'none';
  let maxChannel = 1;
  if (onvifMax > 1 && onvifProfiles.length > 0) {
    protocol = 'onvif';
    maxChannel = onvifMax;
  } else if (sunapiMax > 1) {
    protocol = 'sunapi';
    maxChannel = sunapiMax;
  }

  console.log('── Decision (mirrors probe-channels) ──');
  console.log(`  protocol=${protocol}  maxChannel=${maxChannel}`);

  if (protocol === 'none' && maxChannel === 1) {
    console.log('');
    console.log('  NOTE: reported as single-channel. If this camera is a known multi-channel');
    console.log('  NVR, check: (1) credentials are correct — SUNAPI 401/403 is logged above as');
    console.log('  "auth rejected"; (2) the ONVIF device_service path (guessed as /onvif/device_service)');
    console.log('  matches this vendor; (3) --https / --http-port if the SUNAPI web UI is not on');
    console.log('  plain HTTP:80.');
  }
})();
