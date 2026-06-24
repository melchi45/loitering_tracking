'use strict';

/**
 * ONVIF MetadataStream XML parser — lightweight regex-based, no external deps.
 *
 * Input:  base64-encoded RTSP application RTP packet payload
 * Output: ParsedOnvifEvent[]  |  null (not ONVIF / parse error)
 *
 * A single MetadataStream packet may contain multiple NotificationMessage blocks.
 * parseOnvifPayload() returns an ARRAY — one entry per NotificationMessage found.
 *
 * TOPIC_MAP: maps exact topic path → { type, label, severity }
 *   • type     — stored as topicType in DB, used as dropdown filter key
 *   • label    — human-readable name shown in the UI timeline type dropdown
 *   • severity — 'info' | 'warning' | 'critical'
 *
 * Unknown topics (not in TOPIC_MAP): type = full topic path, label = last
 * path segment with namespace prefix stripped (e.g. 'tns1:DetectedSound' → 'DetectedSound').
 * This ensures each unknown topic gets its own distinct row in the timeline.
 */

const TOPIC_MAP = {
  // ── Standard ONVIF ────────────────────────────────────────────────────────
  'tns1:VideoSource/tns1:MotionAlarm':                               { type: 'motionAlarm',           label: 'Motion Alarm',          severity: 'warning'  },
  'tns1:VideoSource/MotionAlarm':                                    { type: 'motionAlarm',           label: 'Motion Alarm',          severity: 'warning'  },
  // ── ONVIF Radiometry (thermal cameras) ───────────────────────────────────
  'tns1:VideoAnalytics/Radiometry/BoxTemperatureReading':            { type: 'boxTemperatureReading', label: 'Box Temperature',        severity: 'info'     },
  'tns1:VideoSource/RadiometryAlarm':                                { type: 'radiometryAlarm',       label: 'Radiometry Alarm',       severity: 'warning'  },
  'tns1:RuleEngine/Radiometry/TemperatureAlarm':                     { type: 'temperatureAlarm',      label: 'Temperature Alarm',      severity: 'warning'  },
  'tns1:RuleEngine/Detection/TemperatureDifference':                 { type: 'temperatureDifference', label: 'Temperature Difference', severity: 'info'     },
  // ── Audio ─────────────────────────────────────────────────────────────────
  'tns1:AudioAnalytics/tns1:Audio/tns1:DetectedSound':              { type: 'audioAlarm',            label: 'Audio Alarm',            severity: 'warning'  },
  'tns1:AudioAnalytics/tns1:Audio/tns1:AudioAlarm':                 { type: 'audioAlarm',            label: 'Audio Alarm',            severity: 'warning'  },
  // ── Tamper ────────────────────────────────────────────────────────────────
  'tns1:VideoSource/tns1:GlobalSceneChange/tns1:ImageTooBlurry':    { type: 'tamperBlurry',          label: 'Tamper (Blur)',          severity: 'warning'  },
  'tns1:VideoSource/tns1:GlobalSceneChange/tns1:ImageTooBright':    { type: 'tamperBright',          label: 'Tamper (Bright)',        severity: 'warning'  },
  'tns1:VideoSource/tns1:GlobalSceneChange/tns1:ImageTooDark':      { type: 'tamperDark',            label: 'Tamper (Dark)',          severity: 'warning'  },
  'tns1:VideoSource/tns1:GlobalSceneChange':                        { type: 'tamper',                label: 'Tamper Alarm',           severity: 'warning'  },
  // ── Line / Area ───────────────────────────────────────────────────────────
  'tns1:VideoAnalytics/tns1:Line/tns1:Crossed':                     { type: 'lineCrossed',           label: 'Line Crossing',          severity: 'warning'  },
  'tns1:VideoAnalytics/tns1:Field/tns1:Entered':                    { type: 'fieldEntered',          label: 'Area Entry',             severity: 'warning'  },
  'tns1:VideoAnalytics/tns1:Field/tns1:Exited':                     { type: 'fieldExited',           label: 'Area Exit',              severity: 'info'     },
  'tns1:RuleEngine/tns1:LineDetector/tns1:Crossed':                 { type: 'lineCrossed',           label: 'Line Crossing',          severity: 'warning'  },
  'tns1:RuleEngine/tns1:FieldDetector/tns1:ObjectsInside':          { type: 'fieldEntered',          label: 'Area Intrusion',         severity: 'warning'  },
  // ── Device triggers ───────────────────────────────────────────────────────
  'tns1:Device/tns1:Trigger/CallRequest':                           { type: 'callRequest',           label: 'Call Request',           severity: 'info'     },
  'tns1:Device/tns1:Trigger/tns1:DigitalInput':                     { type: 'digitalInput',          label: 'Digital Input',          severity: 'info'     },
  'tns1:Device/tns1:Trigger/tnssamsung:DigitalInput':               { type: 'digitalInput',          label: 'Digital Input',          severity: 'info'     },
  'tns1:Device/tns1:Trigger/tns1:Relay':                            { type: 'relay',                 label: 'Relay Output',           severity: 'info'     },
  'tns1:Device/tns1:HardwareFailure/tns1:StorageFailure':           { type: 'storageFailure',        label: 'Storage Failure',        severity: 'critical' },
  // ── Samsung WiseNet (tnssamsung namespace) ────────────────────────────────
  'tnssamsung:IVA/Fire':                                            { type: 'fire',                  label: 'Fire Detected',          severity: 'critical' },
  'tnssamsung:IVA/Smoke':                                           { type: 'smoke',                 label: 'Smoke Detected',         severity: 'critical' },
  'tnssamsung:IVA/ObjectDetection':                                 { type: 'objectDetection',       label: 'Object Detection',       severity: 'info'     },
  'tnssamsung:IVA/LoiteringDetection':                              { type: 'loiteringDetection',    label: 'Loitering Detection',    severity: 'warning'  },
  'tnssamsung:IVA/AudioDetection':                                  { type: 'audioAlarm',            label: 'Audio Alarm',            severity: 'warning'  },
  'tnssamsung:IVA/LineCrossing':                                    { type: 'lineCrossed',           label: 'Line Crossing',          severity: 'warning'  },
  'tnssamsung:IVA/DirectionalMotion':                               { type: 'directionalMotion',     label: 'Directional Motion',     severity: 'warning'  },
  'tnssamsung:IVA/FogDetection':                                    { type: 'fogDetection',          label: 'Fog Detection',          severity: 'warning'  },
  'tnssamsung:IVA/DefocusDetection':                                { type: 'defocusDetection',      label: 'Defocus Detection',      severity: 'warning'  },
  'tnssamsung:IVA/ShockDetection':                                  { type: 'shockDetection',        label: 'Shock Detection',        severity: 'warning'  },
  'tnssamsung:IVA/FaceDetection':                                   { type: 'faceDetection',         label: 'Face Detection',         severity: 'info'     },
  'tnssamsung:IVA/LPR':                                            { type: 'lpr',                   label: 'LPR',                    severity: 'info'     },
  'tnssamsung:AudioDetection':                                      { type: 'audioAlarm',            label: 'Audio Alarm',            severity: 'warning'  },
  'tnssamsung:AudioAlarm':                                          { type: 'audioAlarm',            label: 'Audio Alarm',            severity: 'warning'  },
  'tnssamsung:Tamper':                                              { type: 'tamper',                label: 'Tamper Alarm',           severity: 'warning'  },
  'tnssamsung:VideoSource/tns1:MotionAlarm':                        { type: 'motionAlarm',           label: 'Motion Alarm',           severity: 'warning'  },
  // ── Samsung WiseNet — full-path variants ─────────────────────────────────
  'tns1:VideoAnalytics/tnssamsung:MotionDetection':                 { type: 'motionAlarm',           label: 'Motion Alarm',           severity: 'warning'  },
  'tns1:AudioSource/tnssamsung:AudioDetection':                     { type: 'audioAlarm',            label: 'Audio Alarm',            severity: 'warning'  },
};

// ── State item names tried in order (standard ONVIF + vendor extensions) ──────
// Samsung WiseNet uses 'State'. Other vendors may use 'IsMotion', 'IsSoundDetected', etc.
const STATE_ITEM_NAMES = [
  'State', 'IsMotion', 'IsSoundDetected', 'IsAlarm', 'IsActive', 'Active',
  'Enabled', 'IsEnabled', 'IsTriggered', 'IsDetected', 'Value',
];

/**
 * Extract boolean state from SimpleItem map.
 * Returns 'true' | 'false' | null.
 * Normalizes 'True'/'False', '1'/'0' to lowercase strings.
 */
function extractState(items) {
  // Try well-known keys first
  for (const key of STATE_ITEM_NAMES) {
    const v = items[key];
    if (v === 'true'  || v === 'True')  return 'true';
    if (v === 'false' || v === 'False') return 'false';
    if (v === '1') return 'true';
    if (v === '0') return 'false';
  }
  // Last resort: any item whose value is a bare boolean string,
  // excluding common non-boolean fields (tokens, channel ids, etc.)
  for (const [k, v] of Object.entries(items)) {
    const kl = k.toLowerCase();
    if (kl.includes('token') || kl.includes('channel') || kl.includes('source')) continue;
    if (v === 'true' || v === 'false') return v;
  }
  return null;
}

/**
 * Extract BoxTemperatureReading elements from ONVIF Radiometry XML.
 * Returns an array of readings (one per box area), or [] if none found.
 *
 * Element format:
 *   <ttr:BoxTemperatureReading ItemID="D" AreaName="D"
 *     MaxTemperature="352.5" MaxTemperatureCoordinatesX="243" MaxTemperatureCoordinatesY="217"
 *     MinTemperature="329.6" MinTemperatureCoordinatesX="328" MinTemperatureCoordinatesY="261"
 *     AverageTemperature="343.5"/>
 */
function parseRadiometryReadings(xml) {
  const readings = [];
  const re = /<(?:[^:>\s]+:)?BoxTemperatureReading\s+([^>]+?)\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const getAttr = (name) => {
      const mm = new RegExp(`${name}="([^"]*)"`).exec(attrs);
      return mm ? mm[1] : null;
    };
    const maxTempStr = getAttr('MaxTemperature');
    const minTempStr = getAttr('MinTemperature');
    if (maxTempStr === null && minTempStr === null) continue;
    readings.push({
      itemId:   getAttr('ItemID'),
      areaName: getAttr('AreaName') || getAttr('ItemID'),
      maxTemp:  maxTempStr  !== null ? parseFloat(maxTempStr)  : null,
      maxTempX: getAttr('MaxTemperatureCoordinatesX') !== null ? parseInt(getAttr('MaxTemperatureCoordinatesX'), 10) : null,
      maxTempY: getAttr('MaxTemperatureCoordinatesY') !== null ? parseInt(getAttr('MaxTemperatureCoordinatesY'), 10) : null,
      minTemp:  minTempStr  !== null ? parseFloat(minTempStr)  : null,
      minTempX: getAttr('MinTemperatureCoordinatesX') !== null ? parseInt(getAttr('MinTemperatureCoordinatesX'), 10) : null,
      minTempY: getAttr('MinTemperatureCoordinatesY') !== null ? parseInt(getAttr('MinTemperatureCoordinatesY'), 10) : null,
      avgTemp:  getAttr('AverageTemperature') !== null ? parseFloat(getAttr('AverageTemperature')) : null,
    });
  }
  return readings;
}

/**
 * Strip namespace prefix from the last segment of a topic path.
 * e.g. 'tns1:AudioAnalytics/tns1:Audio/tns1:DetectedSound' → 'DetectedSound'
 *      'tnssamsung:AudioAlarm'                              → 'AudioAlarm'
 */
function topicLabel(topic) {
  const last = topic.split('/').pop() || topic;
  return last.replace(/^[^:]+:/, '') || last;
}

/**
 * Parse a single NotificationMessage block (inner XML between the tags).
 * Returns ParsedOnvifEvent | null.
 */
function parseSingleNotification(blockXml) {
  const topicMatch = blockXml.match(/<[^:>\s]*:?Topic[^>]*>([^<]+)<\/[^:>\s]*:?Topic>/);
  if (!topicMatch) return null;
  const topic = topicMatch[1].trim();

  const utcTimeMatch = blockXml.match(/UtcTime="([^"]+)"/);
  const opMatch      = blockXml.match(/PropertyOperation="([^"]+)"/);
  const utcTime   = utcTimeMatch ? utcTimeMatch[1] : new Date().toISOString();
  const operation = opMatch      ? opMatch[1]      : 'Changed';

  // All SimpleItem Name/Value pairs (handles both attr orderings)
  const items = {};
  const siRe = /SimpleItem(?:[^>]*?\s(?:Name="([^"]+)"[^/]*?Value="([^"]*)"|Value="([^"]*)"[^/]*?Name="([^"]+)"))/g;
  let m;
  while ((m = siRe.exec(blockXml)) !== null) {
    const name  = m[1] || m[4];
    const value = m[2] !== undefined ? m[2] : m[3];
    if (name !== undefined) items[name] = value;
  }
  // Fallback: simpler regex for Samsung format where attrs are on same line
  if (Object.keys(items).length === 0) {
    const simple = /Name="([^"]+)"\s+Value="([^"]*)"/g;
    while ((m = simple.exec(blockXml)) !== null) { items[m[1]] = m[2]; }
  }
  // Second fallback: reverse order Value="Y" Name="X"
  if (Object.keys(items).length === 0) {
    const rev = /Value="([^"]*)"\s+Name="([^"]+)"/g;
    while ((m = rev.exec(blockXml)) !== null) { items[m[2]] = m[1]; }
  }

  const info = TOPIC_MAP[topic] ?? {
    type:     topic,
    label:    topicLabel(topic),
    severity: 'info',
  };

  const sourceToken =
    items['SourceToken'] ??
    items['VideoSourceToken'] ??
    items['VideoSourceConfigurationToken'] ??
    items['VideoAnalyticsConfigurationToken'] ??
    items['AudioSourceConfigurationToken'] ??
    null;

  // RuleName distinguishes multiple rules on the same source (e.g. VideoAnalytics rules).
  // Events with different RuleNames must be treated as independent event streams.
  const ruleName = items['RuleName'] ?? items['Rule'] ?? null;

  const radiometry = blockXml.includes('BoxTemperatureReading')
    ? parseRadiometryReadings(blockXml)
    : null;

  return {
    topic,
    topicType:   info.type,
    topicLabel:  info.label,
    severity:    info.severity,
    utcTime,
    operation,
    sourceToken,
    ruleName,
    state:       extractState(items),
    items,
    radiometry:  radiometry && radiometry.length > 0 ? radiometry : null,
  };
}

/**
 * Parse base64 ONVIF payload.
 * Returns ParsedOnvifEvent[] (one per NotificationMessage), or null if not
 * a MetadataStream or on error.
 *
 * A MetadataStream packet typically batches multiple NotificationMessage
 * blocks together. Each is parsed independently so no data is lost.
 */
function parseOnvifPayload(base64Payload) {
  try {
    const xml = Buffer.from(base64Payload, 'base64').toString('utf-8');
    if (!xml.includes('MetadataStream')) return null;

    // Extract each NotificationMessage block individually
    const notifRe = /<(?:[^:>\s]+:)?NotificationMessage>([\s\S]*?)<\/(?:[^:>\s]+:)?NotificationMessage>/g;
    const results = [];
    let m;
    while ((m = notifRe.exec(xml)) !== null) {
      const parsed = parseSingleNotification(m[1]);
      if (parsed) results.push(parsed);
    }

    // Fallback: no NotificationMessage wrappers found — treat whole XML as one message
    if (results.length === 0) {
      const parsed = parseSingleNotification(xml);
      if (parsed) return [parsed];
      return null;
    }

    return results;
  } catch {
    return null;
  }
}

module.exports = { parseOnvifPayload, parseRadiometryReadings, TOPIC_MAP };
