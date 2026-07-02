'use strict';

const dgram  = require('dgram');
const http   = require('http');
const https  = require('https');
const { EventEmitter } = require('events');
const { randomUUID }   = require('crypto');

const ONVIF_MULTICAST_ADDR = '239.255.255.250';
const ONVIF_MULTICAST_PORT = 3702;
const PROBE_TIMEOUT  = 8000;  // ms — wait for probe responses
const HTTP_TIMEOUT   = 4000;  // ms — per SOAP call

// ─── SOAP message builders ────────────────────────────────────────────────────

function buildProbe(uuid) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <s:Header>
    <a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>
    <a:MessageID>urn:uuid:${uuid}</a:MessageID>
    <a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>
    <a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>
  </s:Header>
  <s:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </s:Body>
</s:Envelope>`;
}

function buildGetDeviceInformation() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <s:Header/><s:Body><tds:GetDeviceInformation/></s:Body>
</s:Envelope>`;
}

function buildGetCapabilities() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <s:Header/><s:Body>
    <tds:GetCapabilities>
      <tds:Category>Media</tds:Category>
    </tds:GetCapabilities>
  </s:Body>
</s:Envelope>`;
}

function buildGetProfiles() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
  <s:Header/><s:Body><trt:GetProfiles/></s:Body>
</s:Envelope>`;
}

function buildGetVideoSources() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
  <s:Header/><s:Body><trt:GetVideoSources/></s:Body>
</s:Envelope>`;
}

function buildGetStreamUri(profileToken) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Header/><s:Body>
    <trt:GetStreamUri>
      <trt:StreamSetup>
        <tt:Stream>RTP-Unicast</tt:Stream>
        <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
      </trt:StreamSetup>
      <trt:ProfileToken>${profileToken}</trt:ProfileToken>
    </trt:GetStreamUri>
  </s:Body>
</s:Envelope>`;
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

function extractTag(xml, tag) {
  const re = new RegExp(`<(?:[^:>\\s]+:)?${tag}(?:\\s[^>]*)?>([^<]*)`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<(?:[^:>\\s]+:)?${tag}[^>]+${attr}="([^"]*)"`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractAllAttrs(xml, tag, attr) {
  const results = [];
  const re = new RegExp(`<(?:[^:>\\s]+:)?${tag}[^>]+${attr}="([^"]*)"`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

// Split XML into repeated <Profiles> blocks for per-profile parsing
function splitProfileBlocks(xml) {
  const blocks = [];
  const re = /<(?:[^:>\s]+:)?Profiles[\s\S]*?<\/(?:[^:>\s]+:)?Profiles>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

// ─── HTTP SOAP client ─────────────────────────────────────────────────────────

// redirectsLeft bounds a same-host 301/302/307/308 follow to one hop — the
// guessed XAddr (http://{ip}/onvif/device_service, see enrichDevice()) hits
// devices that force HTTP→HTTPS on the plain port (observed: 192.168.214.37),
// and every SOAP call fails with a raw "HTTP 301" otherwise. Only
// same-hostname redirects are followed (no cross-host hop) to avoid an SSRF
// pivot via an unexpected Location header.
function soapPost(xaddr, body, redirectsLeft = 1) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(xaddr); } catch { return reject(new Error('Invalid XAddr')); }

    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const bodyBuf = Buffer.from(body, 'utf8');

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname || '/onvif/device_service',
      method:   'POST',
      headers: {
        'Content-Type':   'text/xml; charset=utf-8',
        'Content-Length': bodyBuf.length,
      },
      timeout: HTTP_TIMEOUT,
      rejectUnauthorized: false,
    };

    const req = lib.request(options, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && redirectsLeft > 0 && res.headers.location) {
        res.resume(); // discard body — we're not using this response
        let loc = null;
        try { loc = new URL(res.headers.location, xaddr); } catch { /* ignore */ }
        if (loc && loc.hostname.toLowerCase() === url.hostname.toLowerCase()) {
          console.debug(`[ONVIFDiscovery] ${url.hostname} ${options.path} → HTTP ${res.statusCode} redirect to ${loc.toString()} — following`);
          resolve(soapPost(loc.toString(), body, redirectsLeft - 1));
          return;
        }
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end',  () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else if (res.statusCode === 401) {
          reject(new Error('AUTH_REQUIRED'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bodyBuf);
    req.end();
  });
}

// ─── Device enrichment ───────────────────────────────────────────────────────

async function enrichDevice(ip, xaddr) {
  const result = {
    Manufacturer: '',
    Model:        '',
    FirmwareVersion: '',
    SerialNumber: '',
    mediaUrl:     xaddr,
    profiles:     [],
    rtspUrl:      null,
  };

  console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} — starting probe at ${xaddr}`);

  // 1. GetDeviceInformation (best-effort, no auth)
  try {
    const xml = await soapPost(xaddr, buildGetDeviceInformation());
    result.Manufacturer    = extractTag(xml, 'Manufacturer') || '';
    result.Model           = extractTag(xml, 'Model')        || '';
    result.FirmwareVersion = extractTag(xml, 'FirmwareVersion') || '';
    result.SerialNumber    = extractTag(xml, 'SerialNumber')    || '';
    console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetDeviceInformation → ${result.Manufacturer || '(unknown)'} ${result.Model || ''}`.trim());
  } catch (err) {
    console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetDeviceInformation failed: ${err.message}`);
  }

  // 2. GetCapabilities → find media service URL
  try {
    const xml = await soapPost(xaddr, buildGetCapabilities());
    const mediaXAddr = extractTag(xml, 'XAddr');
    if (mediaXAddr) result.mediaUrl = mediaXAddr;
    console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetCapabilities → mediaUrl=${result.mediaUrl}`);
  } catch (err) {
    console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetCapabilities failed (using device_service as media URL): ${err.message}`);
  }

  // 3. GetVideoSources at media URL — authoritative physical-channel enumeration
  // (VideoSource_0, VideoSource_1, ... — one per physical video input on the
  // device), independent of whether GetProfiles happens to expose a profile
  // for every channel. Some NVRs only auto-create profiles for channels an
  // operator has actually opened in the vendor UI, which would undercount
  // MaxChannel if derived from GetProfiles' SourceToken set alone (below).
  let videoSourceTokens = [];
  try {
    const xml = await soapPost(result.mediaUrl, buildGetVideoSources());
    videoSourceTokens = extractAllAttrs(xml, 'VideoSources', 'token');
    console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetVideoSources → ${videoSourceTokens.length} VideoSource(s)${videoSourceTokens.length ? ': ' + videoSourceTokens.join(', ') : ''}`);
  } catch (err) {
    console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetVideoSources failed: ${err.message}`);
  }

  // 4. GetProfiles at media URL
  let profileTokens = [];
  // sourceTokenOrder maps SourceToken string → 1-based channel index (insertion order) —
  // fallback ordering used only when GetVideoSources above returned nothing (older/
  // non-compliant firmware); videoSourceTokens' order is authoritative when present.
  const sourceTokenOrder = new Map();
  try {
    const xml    = await soapPost(result.mediaUrl, buildGetProfiles());
    const blocks = splitProfileBlocks(xml);

    for (const block of blocks) {
      const token    = extractAttr(block, 'Profiles', 'token');
      const name     = extractTag(block, 'Name')     || token || '';
      const encoding = extractTag(block, 'Encoding') || '';
      const width    = parseInt(extractTag(block, 'Width')  || '0', 10);
      const height   = parseInt(extractTag(block, 'Height') || '0', 10);
      const fps      = parseInt(extractTag(block, 'FrameRateLimit') || '0', 10);
      // SourceToken identifies the physical video input:
      //   single-channel cameras share one SourceToken across all profiles (main/sub);
      //   NVR channels each have a distinct SourceToken (one per physical input) —
      //   the same token GetVideoSources reports for that channel.
      const srcToken = extractTag(block, 'SourceToken') || '';
      if (srcToken && !sourceTokenOrder.has(srcToken)) {
        sourceTokenOrder.set(srcToken, sourceTokenOrder.size + 1);
      }
      if (token) {
        profileTokens.push(token);
        // channelIndex: prefer this profile's position within GetVideoSources'
        // authoritative, physically-ordered token list; fall back to
        // insertion-order-within-GetProfiles when GetVideoSources is unavailable.
        const vsIndex = srcToken ? videoSourceTokens.indexOf(srcToken) : -1;
        const channelIndex = vsIndex >= 0
          ? vsIndex + 1
          : (srcToken ? (sourceTokenOrder.get(srcToken) || 1) : 1);
        result.profiles.push({ token, name, encoding, width, height, fps, rtspUrl: '',
                                sourceToken: srcToken, channelIndex });
      }
    }
    console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetProfiles → ${profileTokens.length} profile(s), ${sourceTokenOrder.size} distinct SourceToken(s)`);
  } catch (err) {
    console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetProfiles failed: ${err.message}`);
  }

  // 5. GetStreamUri for each profile (up to 16 — cover large NVRs)
  let resolvedUriCount = 0;
  for (let i = 0; i < Math.min(profileTokens.length, 16); i++) {
    try {
      const xml = await soapPost(result.mediaUrl, buildGetStreamUri(profileTokens[i]));
      const uri = extractTag(xml, 'Uri');
      if (uri) {
        result.profiles[i].rtspUrl = uri;
        resolvedUriCount++;
        // Use first profile of channel 1 as the device-level rtspUrl
        if (!result.rtspUrl && result.profiles[i].channelIndex === 1) result.rtspUrl = uri;
      }
    } catch (err) {
      console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} GetStreamUri(${profileTokens[i]}) failed: ${err.message}`);
    }
  }

  // Fallback RTSP URL
  if (!result.rtspUrl) {
    result.rtspUrl = `rtsp://${ip}:554/`;
  }

  // MaxChannel: prefer GetVideoSources' direct physical-channel enumeration
  // (VideoSource_0, VideoSource_1, ... — authoritative, and doesn't depend on
  // GetProfiles exposing a profile for every channel). Falls back to the
  // GetProfiles-derived distinct-SourceToken count when GetVideoSources is
  // unavailable/empty (older/non-compliant firmware), then to 1.
  result.videoSourceTokens = videoSourceTokens;
  result.MaxChannel = videoSourceTokens.length > 0
    ? videoSourceTokens.length
    : (sourceTokenOrder.size > 0 ? sourceTokenOrder.size : 1);
  // Protocol-specific alias so callers/UI can show ONVIF's own reported count
  // distinctly from SUNAPI's (see discoveryService.js's SunapiMaxChannel) —
  // MaxChannel itself stays the historical merged/generic field.
  result.OnvifMaxChannel = result.MaxChannel;
  result.Channel    = 1;

  console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} result → MaxChannel=${result.MaxChannel}, profiles=${result.profiles.length} (${resolvedUriCount} with resolved RTSP URI)`);

  return result;
}

/**
 * Like `enrichDevice()`, but for callers that only have an IP + guessed port
 * (no device-asserted XAddr to work from — currently `POST /api/cameras/probe-channels`,
 * §4.6/FR-CH-045) and so cannot know in advance whether the device's ONVIF
 * service answers on plain HTTP or HTTPS. Tries both schemes in parallel
 * (bounded by the caller's existing overall timeout wrapper, same latency
 * budget as trying one) and returns whichever produced a usable result —
 * mirroring §4.6's own "both protocols tried independently" rationale, just
 * one layer down (both schemes of the same protocol). ONVIFDiscovery's own
 * WS-Discovery path (below) does NOT need this — the XAddr there comes
 * straight from the device's own ProbeMatch response, so the scheme is
 * already known, not guessed.
 */
async function enrichDeviceAutoScheme(ip, { onvifPort, onvifHttpsPort } = {}) {
  const httpXAddr  = `http://${ip}:${onvifPort || 80}/onvif/device_service`;
  const httpsXAddr = `https://${ip}:${onvifHttpsPort || 443}/onvif/device_service`;

  const [httpResult, httpsResult] = await Promise.all([
    enrichDevice(ip, httpXAddr).catch(() => null),
    enrichDevice(ip, httpsXAddr).catch(() => null),
  ]);

  const isUseful = (r) => !!r && (r.Manufacturer || r.Model || r.profiles.length > 0 || r.MaxChannel > 1);

  if (isUseful(httpResult)) {
    console.debug(`[ONVIFDiscovery][enrichDeviceAutoScheme] ${ip} → HTTP result used (maxChannel=${httpResult.MaxChannel})`);
    return httpResult;
  }
  if (isUseful(httpsResult)) {
    console.debug(`[ONVIFDiscovery][enrichDeviceAutoScheme] ${ip} → HTTPS result used (maxChannel=${httpsResult.MaxChannel}) — HTTP attempt was empty`);
    return httpsResult;
  }
  // Neither scheme produced anything (both likely auth-rejected/timed out) —
  // return the HTTP result to preserve the historical default shape/behavior.
  console.debug(`[ONVIFDiscovery][enrichDeviceAutoScheme] ${ip} → neither HTTP nor HTTPS produced usable data`);
  return httpResult || httpsResult || null;
}

// ─── ONVIFDiscovery class ─────────────────────────────────────────────────────

/**
 * ONVIF WS-Discovery: sends a multicast UDP Probe, collects ProbeMatch
 * responses, then enriches each discovered device via ONVIF HTTP/SOAP calls.
 *
 * Events:
 *   'device'  — camera found or updated, payload: DeviceInfo object
 *   'done'    — probe window closed (enrichment may still be running)
 *   'error'   — non-fatal error
 */
class ONVIFDiscovery extends EventEmitter {
  constructor(options = {}) {
    super();
    this.timeout  = options.timeout || PROBE_TIMEOUT;
    this._socket  = null;
    this._timer   = null;
    this._seen    = new Set();
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._seen.clear();

    const socket  = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this._socket  = socket;
    const probeId = randomUUID();
    const probe   = Buffer.from(buildProbe(probeId), 'utf8');

    socket.on('error', (err) => {
      this.emit('error', err);
      this._cleanup();
    });

    socket.on('message', (msg) => {
      if (!this._running) return;
      const xml = msg.toString('utf8');

      // Must be a ProbeMatch, not our own Probe echoed back
      if (!xml.includes('ProbeMatch') && !xml.includes('XAddrs')) return;

      const xaddrRaw = extractTag(xml, 'XAddrs');
      if (!xaddrRaw) return;

      const xaddr = xaddrRaw.split(/\s+/)[0];
      let ip;
      try { ip = new URL(xaddr).hostname; } catch { return; }

      if (this._seen.has(ip)) return;
      this._seen.add(ip);
      console.log(`[ONVIFDiscovery] Found: ${ip} (${xaddr})`);

      // Derive MAC from EndpointReference if present (format: urn:uuid:... or similar)
      const epRef = extractTag(xml, 'Address') || '';

      const basic = this._makeDevice(ip, xaddr, epRef);
      this.emit('device', basic);

      // Enrich asynchronously — emits updated device when done
      enrichDevice(ip, xaddr)
        .then((info) => {
          if (!info.Model && !info.Manufacturer && !info.rtspUrl) return;
          this.emit('device', { ...basic, ...info });
        })
        .catch(() => {});
    });

    socket.bind({ address: '0.0.0.0', port: ONVIF_MULTICAST_PORT }, () => {
      try {
        // Join multicast group so we receive ProbeMatch responses sent to 239.255.255.250:3702
        socket.addMembership(ONVIF_MULTICAST_ADDR);
        socket.setMulticastTTL(4);
        socket.setMulticastLoopback(false);
        socket.send(probe, 0, probe.length, ONVIF_MULTICAST_PORT, ONVIF_MULTICAST_ADDR);
        console.log('[ONVIFDiscovery] Probe sent to', ONVIF_MULTICAST_ADDR);
      } catch (err) {
        this.emit('error', err);
      }
    });

    this._timer = setTimeout(() => {
      this._cleanup();
      this.emit('done');
    }, this.timeout);
  }

  stop() {
    this._running = false;
    this._cleanup();
    this.emit('done');
  }

  _cleanup() {
    if (this._timer)  { clearTimeout(this._timer); this._timer = null; }
    if (this._socket) { try { this._socket.close(); } catch (_) {} this._socket = null; }
  }

  _makeDevice(ip, xaddr, epRef) {
    const port = (() => { try { return parseInt(new URL(xaddr).port) || 80; } catch { return 80; } })();
    return {
      id:           `onvif_${ip}`,
      source:       'onvif',
      IPAddress:    ip,
      MACAddress:   '',
      Model:        '',
      Manufacturer: '',
      Port:         554,
      HttpPort:     port,
      HttpsPort:    443,
      HttpType:     false,
      SupportSunapi: false,
      SupportOnvif:  true,
      xaddr,
      epRef,
      profiles:     [],
      rtspUrl:      `rtsp://${ip}:554/`,
    };
  }
}

module.exports = { ONVIFDiscovery, enrichDevice, enrichDeviceAutoScheme };
