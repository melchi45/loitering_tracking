'use strict';

const { getUDPDiscovery } = require('../utils/udpDiscovery');

const timeout = parseInt(process.argv[2], 10) || 8000;

const UDPDiscovery = getUDPDiscovery();
console.log(`Using: ${UDPDiscovery.name}`);
console.log(`Scanning for WiseNet cameras (timeout: ${timeout}ms)…\n`);

const discovery = new UDPDiscovery({ timeout });
let count = 0;

discovery.on('listening', () => console.log('Socket bound — broadcast sent.\n'));

discovery.on('device', (raw) => {
  count++;

  // Map raw fields exactly as streamHandler does
  const mac        = (raw.chMac  || raw.MACAddress || '').replace(/\xff/g, '').trim();
  const ip         = (raw.chIP   || raw.IPAddress  || '').replace(/\xff/g, '').trim();
  const model      = (raw.chDeviceNameNew && raw.chDeviceNameNew !== '')
                       ? raw.chDeviceNameNew
                       : (raw.chDeviceName || raw.Model || '');
  const httpPort   = (!raw.nHttpPort  || raw.nHttpPort  === 0) ? 80  : raw.nHttpPort;
  const httpsPort  = (!raw.nHttpsPort || raw.nHttpsPort === 0) ? 443 : raw.nHttpsPort;
  const httpType   = (raw.httpType != null) ? (raw.httpType !== 0) : false;
  const scheme     = httpType ? 'https' : 'http';
  const webPort    = httpType ? httpsPort : httpPort;
  const rtspUrl    = raw.rtspUrl || `rtsp://${ip}:${raw.nPort || 554}/profile1/media.smp`;

  console.log(`── Camera #${count} ──────────────────────────────`);
  console.log(`  Model   : ${model || '(unknown)'}`);
  console.log(`  IP      : ${ip}`);
  console.log(`  MAC     : ${mac}`);
  console.log(`  Gateway : ${(raw.chGateway   || '').replace(/\xff/g, '').trim() || '-'}`);
  console.log(`  Subnet  : ${(raw.chSubnetMask|| '').replace(/\xff/g, '').trim() || '-'}`);
  console.log(`  Web URL : ${scheme}://${ip}:${webPort}`);
  console.log(`  RTSP    : ${rtspUrl}`);
  console.log(`  SUNAPI  : ${raw.isSupportSunapi === 1 ? 'Yes' : 'No'}`);
  if (raw.DDNSURL) console.log(`  DDNS    : ${raw.DDNSURL}`);
  console.log();
});

discovery.on('done', () => {
  console.log(`─────────────────────────────────────────────`);
  console.log(`Discovery complete. Found ${count} camera(s).`);
  process.exit(0);
});

discovery.on('error', (err) => {
  console.error('Discovery error:', err.message);
  process.exit(1);
});

discovery.start();
