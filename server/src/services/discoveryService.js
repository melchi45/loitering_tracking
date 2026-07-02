'use strict';

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const { getUDPDiscovery }  = require('../utils/udpDiscovery');
const { ONVIFDiscovery }   = require('./onvifDiscovery');

const SCAN_TIMEOUT  = 10000; // each scan duration (ms)
const SCAN_INTERVAL = 15000; // pause between scans — long enough for cameras to reset rate limits

// ─── SUNAPI MaxChannel query (secondary/fallback — see hasConfiguredSunapiCredentials) ─

/**
 * True when explicit SUNAPI credentials are configured (RTSP_DEFAULT_USERNAME
 * + RTSP_DEFAULT_PASSWORD, both non-empty). During the automatic background
 * scan (_runScan), the CGI-based querySunapiMaxChannel() below is now only
 * attempted when this is true — the primary channel-count source is the UDP
 * discovery binary response itself (mapUDPDevice()), which requires no
 * network round-trip and works without any credentials. Without configured
 * credentials, an unauthenticated CGI request to a modern (auth-required)
 * SUNAPI device is essentially guaranteed to 401 — attempting it anyway added
 * a network round-trip to every scan for no benefit.
 */
function hasConfiguredSunapiCredentials() {
  return !!(process.env.RTSP_DEFAULT_USERNAME && process.env.RTSP_DEFAULT_PASSWORD);
}

/**
 * Extract a single <attribute name="..." value="..."/> value from a SUNAPI
 * `attributes.cgi/attributes` XML response, scoped to a specific
 * <group name="..."><category name="..."> block (mirrors the vendor IP
 * Installer's own XMLParser.parseAttributeSection('Group/Category/Attr')
 * — see submodules/WiseNetChromeIPInstaller/media/ump/Network/http/xmlParser.js).
 */
function extractGroupCategoryAttr(xml, groupName, categoryName, attrName) {
  const groupRe = new RegExp(`<group\\s+name="${groupName}"[^>]*>([\\s\\S]*?)<\\/group>`, 'i');
  const groupMatch = xml.match(groupRe);
  if (!groupMatch) return null;
  const categoryRe = new RegExp(`<category\\s+name="${categoryName}"[^>]*>([\\s\\S]*?)<\\/category>`, 'i');
  const categoryMatch = groupMatch[1].match(categoryRe);
  if (!categoryMatch) return null;
  const attrRe = new RegExp(`<attribute\\s+name="${attrName}"[^>]*\\svalue="([^"]*)"`, 'i');
  const attrMatch = categoryMatch[1].match(attrRe);
  return attrMatch ? attrMatch[1].trim() : null;
}

/**
 * Try to read MaxChannel from the WiseNet/Hanwha SUNAPI capability endpoint,
 * GET /stw-cgi/attributes.cgi/attributes — an XML document of
 * <attributes><group name="..."><category name="..."><attribute name="..."
 * type="..." value="..."/></category></group></attributes> blocks. MaxChannel
 * lives at group="System" / category="Limit" / attribute="MaxChannel"
 * (confirmed against the vendor IP Installer's own query path, System/Limit/MaxChannel
 * — see submodules/WiseNetChromeIPInstaller/media/ump/Network/http/attributes.js).
 * SECONDARY source only — see hasConfiguredSunapiCredentials() above and
 * mapUDPDevice()'s binary-response parsing, which is the primary source and
 * needs no HTTP round-trip. This function remains useful as a fallback (the
 * binary field may be absent on older firmware) and for the manual
 * Detect/Re-detect flows (POST /api/cameras/probe-channels), where the
 * operator explicitly supplies credentials in the Add/Edit form.
 * Falls back to env default credentials when no explicit credentials given.
 * Returns 1 on any failure (auth required, timeout, parse error).
 * Resolves quickly (<2 s) so it doesn't block the discovery flow.
 *
 * Auth scheme: tries HTTP Basic first (single round-trip, works on older
 * firmware). Some SUNAPI firmware (observed: nginx-fronted iPolis, e.g.
 * 192.168.214.32) rejects Basic outright and requires HTTP Digest
 * (`WWW-Authenticate: Digest ...` on the 401) — when that challenge is seen
 * and credentials are available, one authenticated retry is made with a
 * computed Digest response (RFC 7616, qop=auth). A camera that rejects a
 * *correct* password will still 401 the Digest retry too, so this doesn't
 * mask genuinely bad credentials — see `buildDigestAuthHeader()`.
 */
// redirectsLeft bounds a same-host 301/302/307/308 follow to one hop — several
// SUNAPI web servers force HTTP→HTTPS on the plain-HTTP port (observed:
// 192.168.214.37) and the CGI response never arrives on that connection
// otherwise. Only same-hostname redirects are followed (no cross-host hop),
// so a malicious/unexpected Location header can't be used to pivot the
// server's outbound request to an arbitrary host (SSRF).
function sunapiRequest(proto, hostname, port, path, timeoutMs, headers, redirectsLeft = 1) {
  return new Promise((resolve, reject) => {
    const req = proto.get({ hostname, port, path, timeout: timeoutMs, headers, rejectUnauthorized: false }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && redirectsLeft > 0 && res.headers.location) {
        res.resume(); // discard body — we're not using this response
        let loc = null;
        try { loc = new URL(res.headers.location, `${proto === https ? 'https' : 'http'}://${hostname}:${port}`); } catch { /* ignore */ }
        if (loc && loc.hostname.toLowerCase() === hostname.toLowerCase()) {
          const nextProto = loc.protocol === 'https:' ? https : http;
          const nextPort  = loc.port || (nextProto === https ? 443 : 80);
          console.debug(`[Discovery][SUNAPI] ${hostname} ${path} → HTTP ${res.statusCode} redirect to ${loc.protocol}//${hostname}:${nextPort}${loc.pathname} — following`);
          resolve(sunapiRequest(nextProto, hostname, nextPort, loc.pathname + loc.search, timeoutMs, headers, redirectsLeft - 1));
          return;
        }
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function parseSunapiMaxChannel(ip, path, statusCode, body) {
  try {
    const raw = extractGroupCategoryAttr(body, 'System', 'Limit', 'MaxChannel');
    const parsed = parseInt(raw, 10) || 0;
    console.debug(`[Discovery][SUNAPI] ${ip} ${path} → HTTP ${statusCode}, MaxChannel=${parsed || '(not reported)'}`);
    if (parsed > 0) return parsed;
  } catch (err) {
    console.debug(`[Discovery][SUNAPI] ${ip} ${path} → HTTP ${statusCode}, XML parse failed: ${err.message}`);
  }
  console.debug(`[Discovery][SUNAPI] ${ip} → attributes.cgi did not report a MaxChannel; defaulting to 1`);
  return 1;
}

/**
 * Computes an RFC 7616 Digest Authorization header from a `WWW-Authenticate`
 * challenge string. Supports the common `qop=auth` case (and falls back to
 * the qop-less RFC 2069 form some embedded HTTP servers still send).
 * MD5 only — no SUNAPI firmware observed advertising SHA-256.
 */
function buildDigestAuthHeader(challenge, method, uri, username, password) {
  const param = (name) => {
    const m = challenge.match(new RegExp(`${name}="?([^",]+)"?`, 'i'));
    return m ? m[1] : null;
  };
  const realm  = param('realm')  || '';
  const nonce  = param('nonce')  || '';
  const opaque = param('opaque');
  const qopOffered = (param('qop') || '').split(',').map((s) => s.trim());
  const qop    = qopOffered.includes('auth') ? 'auth' : null;
  const nc     = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');

  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop)    header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) header += `, opaque="${opaque}"`;
  return header;
}

async function querySunapiMaxChannel(
  ip, httpPort, httpType, timeoutMs = 2000,
  username = process.env.RTSP_DEFAULT_USERNAME || '',
  password = process.env.RTSP_DEFAULT_PASSWORD || '',
) {
  const proto = httpType ? https : http;
  const port  = httpType ? (httpPort || 443) : (httpPort || 80);
  const path  = '/stw-cgi/attributes.cgi/attributes';

  const basicAuthHeader = (username && password)
    ? 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
    : null;

  console.debug(`[Discovery][SUNAPI] querying ${proto === https ? 'https' : 'http'}://${ip}:${port}${path} auth=${basicAuthHeader ? 'yes' : 'no'} timeoutMs=${timeoutMs}`);

  let res;
  try {
    res = await sunapiRequest(proto, ip, port, path, timeoutMs, {
      Accept: 'application/xml, text/xml, */*',
      ...(basicAuthHeader ? { Authorization: basicAuthHeader } : {}),
    });
  } catch (err) {
    console.debug(err.message === 'timeout'
      ? `[Discovery][SUNAPI] ${ip} ${path} → timeout after ${timeoutMs}ms`
      : `[Discovery][SUNAPI] ${ip} ${path} → connection error: ${err.message}`);
    return 1;
  }

  if (res.statusCode === 200) return parseSunapiMaxChannel(ip, path, res.statusCode, res.body);

  if ((res.statusCode === 401 || res.statusCode === 403) && username && password) {
    const challenge = res.headers['www-authenticate'] || '';
    if (/^Digest\s/i.test(challenge)) {
      console.debug(`[Discovery][SUNAPI] ${ip} ${path} → HTTP ${res.statusCode}, Basic rejected — retrying with Digest (challenge received)`);
      const digestHeader = buildDigestAuthHeader(challenge, 'GET', path, username, password);
      try {
        const res2 = await sunapiRequest(proto, ip, port, path, timeoutMs, {
          Accept: 'application/xml, text/xml, */*',
          Authorization: digestHeader,
        });
        if (res2.statusCode === 200) return parseSunapiMaxChannel(ip, path, res2.statusCode, res2.body);
        console.debug(`[Discovery][SUNAPI] ${ip} ${path} → Digest retry HTTP ${res2.statusCode} (auth rejected)`);
        return 1;
      } catch (err) {
        console.debug(err.message === 'timeout'
          ? `[Discovery][SUNAPI] ${ip} ${path} → Digest retry timeout after ${timeoutMs}ms`
          : `[Discovery][SUNAPI] ${ip} ${path} → Digest retry connection error: ${err.message}`);
        return 1;
      }
    }
  }

  console.debug(`[Discovery][SUNAPI] ${ip} ${path} → HTTP ${res.statusCode} (auth rejected)`);
  return 1;
}

// ─── UDP device mapper ────────────────────────────────────────────────────────

function mapUDPDevice(raw) {
  const clean = (v) => String(v || '').replace(/\xff/g, '').replace(/[^\x20-\x7E]/g, '').trim();

  // Accept both WiseNet submodule shape (chIP/chMac/...) and
  // inline fallback shape (ip/mac/model/httpPort/...)
  const mac = clean(raw.chMac || raw.MACAddress || raw.mac);
  const ip  = clean(raw.chIP  || raw.IPAddress  || raw.ip);
  if (!ip) return null;

  const model     = clean(
    (raw.chDeviceNameNew && raw.chDeviceNameNew !== '')
      ? raw.chDeviceNameNew
      : (raw.chDeviceName || raw.Model || raw.model || raw.name)
  );

  const resolvePort = (a, b, fallback) => {
    const v = parseInt(a != null ? a : b, 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };

  const httpPort  = resolvePort(raw.nHttpPort,  raw.httpPort ?? raw.HttpPort,  80);
  const httpsPort = resolvePort(raw.nHttpsPort, raw.httpsPort ?? raw.HttpsPort, 443);
  const rtspPort  = resolvePort(raw.nPort,      raw.Port,                    554);
  const httpType  = raw.httpType != null
    ? raw.httpType !== 0
    : (raw.HttpType != null ? !!raw.HttpType : false);

  const rtspUrl = clean(raw.rtspUrl) || `rtsp://${ip}:${rtspPort}/`;
  const gateway = clean(raw.chGateway || raw.Gateway);
  const subnet  = clean(raw.chSubnetMask || raw.SubnetMask);
  const ddnsUrl = clean(raw.DDNSURL || raw.URL);
  const supportSunapi = raw.isSupportSunapi === 1 || raw.SupportSunapi === true;
  const supportOnvif  = raw.SupportOnvif !== false;
  const id = mac ? `${mac}_${ip}` : `ip_${ip}`;

  if(!ip && ip === '192.168.214.32') {
    console.info(`[Discovery][UDP] ${ip} (${mac || 'no MAC'}) → model=${model || '(unknown)'} httpType=${httpType ? 'https' : 'http'} httpPort=${httpPort} httpsPort=${httpsPort} rtspPort=${rtspPort} SunapiMaxChannel=${raw.MaxChannel || 1} SupportSunapi=${supportSunapi} SupportOnvif=${supportOnvif}`);
  }

  return {
    id,
    source:       'udp',
    Model:        model,
    Manufacturer: 'Hanwha Vision',
    Type:         raw.modelType,
    IPAddress:    ip,
    MACAddress:   mac,
    Port:         rtspPort,
    Channel:      1,
    // TODO(pending SUNAPI IP Installer spec §3.4.2 Response field offset):
    // MaxChannel SHOULD be read directly from the UDP discovery binary
    // response once the exact byte offset/size is confirmed (the current
    // parser in submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js
    // and the inline fallback in utils/udpDiscovery.js both stop at byte 333
    // and do not expose it yet — see docs/design/Design_Channel_Slot.md §4.6a).
    // Until then this stays hardcoded to 1, and the CGI-based
    // querySunapiMaxChannel() secondary path (gated by
    // hasConfiguredSunapiCredentials()) is the only channel-count source.
    MaxChannel:   raw.MaxChannel > 1 ? raw.MaxChannel : 1,
    // Protocol-specific alias (only meaningful when SupportSunapi is true) so
    // the UI can show SUNAPI's own reported count distinctly from ONVIF's
    // (onvifDiscovery.js's OnvifMaxChannel) — MaxChannel itself stays the
    // historical merged/generic field. Updated again below when the CGI
    // fallback (querySunapiMaxChannel()) succeeds with a higher value.
    SunapiMaxChannel: supportSunapi ? (raw.MaxChannel > 1 ? raw.MaxChannel : 1) : undefined,
    HttpType:     httpType,
    HttpPort:     httpPort,
    HttpsPort:    httpsPort,
    Gateway:      gateway,
    SubnetMask:   subnet,
    SupportSunapi: supportSunapi,
    SupportOnvif:  supportOnvif,
    URL:          ddnsUrl,
    rtspUrl,
    profiles:     [],
  };
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

/** Return the registry key for a device — prefers MAC, falls back to IP. */
function deviceKey(dev) {
  if (dev.MACAddress && dev.MACAddress.length > 5) return `mac_${dev.MACAddress}`;
  return `ip_${dev.IPAddress}`;
}

/**
 * Merge an incoming device into an existing one.
 * UDP result wins for Hanwha-specific fields; ONVIF enrichment wins for
 * Manufacturer/FirmwareVersion/SerialNumber/profiles/rtspUrl.
 */
function mergeDevices(existing, incoming) {
  const merged = { ...existing };

  const hasMeaningful = (v) => {
    const s = String(v || '').trim();
    if (!s) return false;
    return !/^unknown$/i.test(s);
  };

  // Source badge
  if (existing.source !== incoming.source) merged.source = 'both';

  // Fill in empty basic fields (never overwrite existing data)
  for (const key of ['Model', 'Manufacturer', 'MACAddress', 'FirmwareVersion',
                      'SerialNumber', 'Gateway', 'SubnetMask', 'URL']) {
    if (!hasMeaningful(merged[key]) && hasMeaningful(incoming[key])) {
      merged[key] = incoming[key];
    }
  }

  // rtspUrl: prefer a real GetStreamUri URL over the fallback 'rtsp://ip:554/'
  if (incoming.rtspUrl) {
    const fallback = `rtsp://${incoming.IPAddress || existing.IPAddress}:554/`;
    if (!merged.rtspUrl || incoming.rtspUrl !== fallback) {
      merged.rtspUrl = incoming.rtspUrl;
    }
  }

  // Capabilities: OR them together
  if (incoming.SupportSunapi) merged.SupportSunapi = true;
  if (incoming.SupportOnvif)  merged.SupportOnvif  = true;

  // ONVIF profiles: take the richer list
  if ((incoming.profiles?.length || 0) > (merged.profiles?.length || 0)) {
    merged.profiles = incoming.profiles;
  }

  // MaxChannel: take the larger value from either protocol
  const maxCh = Math.max(existing.MaxChannel || 1, incoming.MaxChannel || 1);
  merged.MaxChannel = maxCh;

  // Protocol-specific values: each only ever set by its own protocol's code
  // path (mapUDPDevice()/querySunapiMaxChannel() for SUNAPI, enrichDevice()
  // for ONVIF), so a plain max of "whichever side has a value" is correct —
  // there's no cross-protocol contamination to worry about here.
  const sunapiCh = Math.max(existing.SunapiMaxChannel || 0, incoming.SunapiMaxChannel || 0);
  if (sunapiCh > 0) merged.SunapiMaxChannel = sunapiCh;
  const onvifCh = Math.max(existing.OnvifMaxChannel || 0, incoming.OnvifMaxChannel || 0);
  if (onvifCh > 0) merged.OnvifMaxChannel = onvifCh;

  return merged;
}

// ─── DiscoveryService ─────────────────────────────────────────────────────────

class DiscoveryService {
  constructor(io) {
    this._io       = io;
    this._timer    = null;
    this._udpDisc  = null;
    this._onvifDisc = null;
    this._known    = new Map();   // deviceKey → device
    this._ipIndex  = new Map();   // IPAddress → deviceKey  (for cross-protocol dedup)
    this._scanning = false;
    this._pendingDone = 0;        // counts how many protocols are still running
  }

  start() {
    console.log('[Discovery] Background discovery started (UDP + ONVIF)');
    this._runScan();
  }

  stop() {
    // Set these first — _onProtocolDone() checks _scanning to skip stray callbacks
    this._scanning    = false;
    this._pendingDone = 0;
    if (this._timer)     { clearTimeout(this._timer); this._timer = null; }
    if (this._udpDisc)   { try { this._udpDisc.stop();   } catch (_) {} this._udpDisc   = null; }
    if (this._onvifDisc) { try { this._onvifDisc.stop(); } catch (_) {} this._onvifDisc = null; }
  }

  rescan() {
    this.stop();
    this._known.clear();
    this._ipIndex.clear();
    this._io.emit('discovery:cleared');
    this._runScan();
  }

  hydrate(socket) {
    for (const device of this._known.values()) {
      socket.emit('discovery:result', { device });
    }
    socket.emit('discovery:scanning', {
      scanning: this._scanning,
      count: this._known.size,
    });
  }

  get knownCount() { return this._known.size; }

  /**
   * Look up an already-discovered device by IP (cached from a prior/ongoing
   * background scan) — no network I/O. Used by POST /api/cameras/probe-channels
   * (FR-CH-065) so on-demand detection can reuse a UDP-scan result already known
   * for this IP instead of always issuing a fresh SUNAPI CGI/ONVIF SOAP query.
   * @param {string} ip
   * @returns {object|null} the cached device (DiscoveredCamera shape) or null
   */
  getByIp(ip) {
    const key = this._ipIndex.get(ip);
    return key ? (this._known.get(key) ?? null) : null;
  }

  /**
   * Correct an already-known device's channel counts with a fresher,
   * authenticated on-demand probe result (FR-CH-067) — e.g. UDP broadcast
   * reported MaxChannel:1 (the binary field isn't parsed yet — see
   * mapUDPDevice()'s TODO), but a POST /api/cameras/probe-channels call with
   * the operator's own per-device credentials (Detect Channels/Re-detect,
   * any of the three UI entry points) queried attributes.cgi directly and
   * got a real, higher answer. Only ever raises values, never lowers them
   * (same Math.max() philosophy as mergeDevices()) — a probe that returns a
   * *lower* number than what's already known doesn't disprove the higher
   * one (e.g. a flaky/incomplete response), so it's ignored rather than
   * regressing the registry.
   *
   * No-op (returns null, no broadcast) when the IP isn't in the registry at
   * all — this only corrects an existing entry, it doesn't create one; a
   * probe against a never-scanned IP has nothing to correct. Also a no-op
   * when the patch doesn't actually raise anything, to avoid a spurious
   * 'discovery:result' broadcast for every no-op probe.
   *
   * On an actual change, broadcasts the updated device via 'discovery:result'
   * — every connected client's Found list/detail panel picks up the
   * correction (via the existing addOrUpdate() socket handler), not just
   * whichever browser tab happened to run the probe.
   *
   * @param {string} ip
   * @param {{ maxChannel?: number, sunapiMaxChannel?: number, onvifMaxChannel?: number|null, supportSunapi?: boolean }} patch
   * @returns {object|null} the updated device, or null if nothing changed
   */
  applyProbeResult(ip, patch) {
    const key = this._ipIndex.get(ip);
    const existing = key ? this._known.get(key) : null;
    if (!existing) return null;

    const updated = { ...existing };
    if (patch.supportSunapi) updated.SupportSunapi = true;
    if (typeof patch.sunapiMaxChannel === 'number' && patch.sunapiMaxChannel > (existing.SunapiMaxChannel || 0)) {
      updated.SunapiMaxChannel = patch.sunapiMaxChannel;
    }
    if (typeof patch.onvifMaxChannel === 'number' && patch.onvifMaxChannel > (existing.OnvifMaxChannel || 0)) {
      updated.OnvifMaxChannel = patch.onvifMaxChannel;
    }
    if (typeof patch.maxChannel === 'number' && patch.maxChannel > (existing.MaxChannel || 1)) {
      updated.MaxChannel = patch.maxChannel;
    }

    const unchanged = updated.MaxChannel === existing.MaxChannel
      && updated.SunapiMaxChannel === existing.SunapiMaxChannel
      && updated.OnvifMaxChannel === existing.OnvifMaxChannel
      && updated.SupportSunapi === existing.SupportSunapi;
    if (unchanged) return null;

    console.debug(`[Discovery] applyProbeResult ${ip}: MaxChannel ${existing.MaxChannel}→${updated.MaxChannel}, SunapiMaxChannel ${existing.SunapiMaxChannel}→${updated.SunapiMaxChannel}, OnvifMaxChannel ${existing.OnvifMaxChannel}→${updated.OnvifMaxChannel}`);
    this._known.set(key, updated);
    this._emit(updated);
    return updated;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _upsert(device) {
    // Check if we already know this IP under a different key (cross-protocol merge)
    let key = deviceKey(device);
    const existingKeyByIp = this._ipIndex.get(device.IPAddress);

    if (existingKeyByIp && existingKeyByIp !== key) {
      // Same camera discovered by both protocols — merge under existing key
      const existing = this._known.get(existingKeyByIp);
      const merged   = mergeDevices(existing, device);
      this._known.set(existingKeyByIp, merged);
      if (device.MACAddress) this._ipIndex.set(device.IPAddress, existingKeyByIp);
      return merged;
    }

    // New or same-protocol update
    const prev   = this._known.get(key);
    const merged = prev ? mergeDevices(prev, device) : device;
    this._known.set(key, merged);
    this._ipIndex.set(device.IPAddress, key);
    return merged;
  }

  _emit(device) {
    this._io.emit('discovery:result', { device });
  }

  _onProtocolDone() {
    if (!this._scanning) return;  // stop() was called — ignore stray done events
    this._pendingDone--;
    if (this._pendingDone <= 0) {
      this._pendingDone = 0;
      this._scanning    = false;
      this._io.emit('discovery:scanning', { scanning: false, count: this._known.size });
      this._timer = setTimeout(() => this._runScan(), SCAN_INTERVAL);
    }
  }

  _runScan() {
    this._scanning    = true;
    this._pendingDone = 2;   // UDP + ONVIF
    this._io.emit('discovery:scanning', { scanning: true });

    // ── UDP (WiseNet) ──────────────────────────────────────────────────────
    const UDPDiscovery = getUDPDiscovery();
    try {
      const udp = new UDPDiscovery({ timeout: SCAN_TIMEOUT });
      this._udpDisc = udp;

      udp.on('device', async (raw) => {
        const device = mapUDPDevice(raw);
        if (!device) return;

        // Primary source: mapUDPDevice() already derives MaxChannel directly
        // from the UDP discovery binary response (no network round-trip) —
        // see mapUDPDevice()'s MaxChannel comment. Emit that immediately.
        const merged = this._upsert(device);
        this._emit(merged);

        // Secondary/fallback only: query the SUNAPI CGI endpoint when the
        // primary (binary) source didn't already report multiple channels —
        // AND only when real credentials are configured, since an
        // unauthenticated CGI request to an auth-required device just wastes
        // a round-trip on every scan for a guaranteed 401. See
        // hasConfiguredSunapiCredentials() / querySunapiMaxChannel() above.
        if (device.SupportSunapi && device.MaxChannel <= 1 && hasConfiguredSunapiCredentials()) {
          try {
            const maxCh = await querySunapiMaxChannel(
              device.IPAddress, device.HttpPort, device.HttpType
            );
            if (maxCh > 1) {
              device.MaxChannel = maxCh;
              device.SunapiMaxChannel = maxCh;
              const updated = this._upsert(device);
              this._emit(updated);
            }
          } catch (_) {}
        }
      });

      udp.on('done',  () => { this._udpDisc = null;  this._onProtocolDone(); });
      udp.on('error', (err) => {
        console.warn('[Discovery][UDP]', err.message);
        this._udpDisc = null;
        this._onProtocolDone();
      });

      udp.start();
    } catch (err) {
      console.error('[Discovery][UDP] failed to start:', err.message);
      this._onProtocolDone();
    }

    // ── ONVIF ──────────────────────────────────────────────────────────────
    try {
      const onvif = new ONVIFDiscovery({ timeout: SCAN_TIMEOUT });
      this._onvifDisc = onvif;

      onvif.on('device', (device) => {
        const merged = this._upsert(device);
        this._emit(merged);
      });

      onvif.on('done',  () => { this._onvifDisc = null; this._onProtocolDone(); });
      onvif.on('error', (err) => {
        console.warn('[Discovery][ONVIF]', err.message);
        this._onvifDisc = null;
        this._onProtocolDone();
      });

      onvif.start();
    } catch (err) {
      console.error('[Discovery][ONVIF] failed to start:', err.message);
      this._onProtocolDone();
    }
  }
}

let _svc = null;

function getDiscoveryService(io) {
  if (!_svc && io) _svc = new DiscoveryService(io);
  return _svc;
}

module.exports = { getDiscoveryService, mapUDPDevice, querySunapiMaxChannel, hasConfiguredSunapiCredentials, buildDigestAuthHeader };
