'use strict';

/**
 * ONVIF MetadataStream XML parser — lightweight regex-based, no external deps.
 *
 * Input:  base64-encoded RTSP application RTP packet payload
 * Output: ParsedOnvifEvent object  |  null (not ONVIF / parse error)
 */

const TOPIC_MAP = {
  'tns1:Device/tns1:Trigger/CallRequest':        { type: 'callRequest',  label: 'Call Request',   severity: 'info'     },
  'tns1:VideoSource/tns1:MotionAlarm':           { type: 'motionAlarm',  label: 'Motion Alarm',   severity: 'warning'  },
  'tns1:VideoAnalytics/tns1:Line/tns1:Crossed':  { type: 'lineCrossed',  label: 'Line Crossing',  severity: 'warning'  },
  'tns1:VideoAnalytics/tns1:Field/tns1:Entered': { type: 'fieldEntered', label: 'Area Entry',     severity: 'warning'  },
  'tns1:VideoAnalytics/tns1:Field/tns1:Exited':  { type: 'fieldExited',  label: 'Area Exit',      severity: 'info'     },
  'tnssamsung:IVA/Fire':                         { type: 'fire',         label: 'Fire Detected',  severity: 'critical' },
  'tnssamsung:IVA/Smoke':                        { type: 'smoke',        label: 'Smoke Detected', severity: 'critical' },
};

/**
 * Parse base64 ONVIF payload. Returns null if not a MetadataStream or on error.
 */
function parseOnvifPayload(base64Payload) {
  try {
    const xml = Buffer.from(base64Payload, 'base64').toString('utf-8');
    if (!xml.includes('MetadataStream')) return null;

    // Topic text (any namespace prefix)
    const topicMatch = xml.match(/<[^:>\s]*:?Topic[^>]*>([^<]+)<\/[^:>\s]*:?Topic>/);
    if (!topicMatch) return null;
    const topic = topicMatch[1].trim();

    // UtcTime and PropertyOperation attributes
    const utcTimeMatch  = xml.match(/UtcTime="([^"]+)"/);
    const opMatch       = xml.match(/PropertyOperation="([^"]+)"/);
    const utcTime   = utcTimeMatch ? utcTimeMatch[1] : new Date().toISOString();
    const operation = opMatch      ? opMatch[1]      : 'Changed';

    // All SimpleItem Name/Value pairs (handles both attr orderings)
    const items = {};
    const siRe = /SimpleItem(?:[^>]*?\s(?:Name="([^"]+)"[^/]*?Value="([^"]*)"|Value="([^"]*)"[^/]*?Name="([^"]+)"))/g;
    let m;
    while ((m = siRe.exec(xml)) !== null) {
      const name  = m[1] || m[4];
      const value = m[2] !== undefined ? m[2] : m[3];
      if (name !== undefined) items[name] = value;
    }
    // Simpler fallback for common Samsung format: Name="X" Value="Y"
    if (Object.keys(items).length === 0) {
      const simple = /Name="([^"]+)"\s+Value="([^"]*)"/g;
      while ((m = simple.exec(xml)) !== null) { items[m[1]] = m[2]; }
    }

    const info = TOPIC_MAP[topic] ?? {
      type: 'unknown',
      label: (topic.split('/').pop() || 'Event'),
      severity: 'info',
    };

    return {
      topic,
      topicType:   info.type,
      topicLabel:  info.label,
      severity:    info.severity,
      utcTime,
      operation,
      sourceToken: items['SourceToken'] ?? null,
      state:       items['State']       ?? null,
      items,
    };
  } catch {
    return null;
  }
}

module.exports = { parseOnvifPayload, TOPIC_MAP };
