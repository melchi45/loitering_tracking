/**
 * Client-side ONVIF MetadataStream XML parser.
 * Mirrors server/src/services/onvifParser.js but uses browser DOMParser.
 *
 * Input:  raw XML string from OnvifEvent.rawXml
 * Output: ParsedOnvifData suitable for structured display
 */

export interface ParsedOnvifData {
  topic: string;
  topicLabel: string;
  utcTime: string;
  operation: string;
  sourceToken: string | null;
  state: string | null;
  items: Record<string, string>;
}

const TOPIC_LABELS: Record<string, string> = {
  'tns1:Device/tns1:Trigger/CallRequest':        'Call Request',
  'tns1:VideoSource/tns1:MotionAlarm':           'Motion Alarm',
  'tns1:VideoAnalytics/tns1:Line/tns1:Crossed':  'Line Crossing',
  'tns1:VideoAnalytics/tns1:Field/tns1:Entered': 'Area Entry',
  'tns1:VideoAnalytics/tns1:Field/tns1:Exited':  'Area Exit',
  'tnssamsung:IVA/Fire':                         'Fire Detected',
  'tnssamsung:IVA/Smoke':                        'Smoke Detected',
};

export function parseOnvifXml(xml: string): ParsedOnvifData | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');

    const parseError = doc.querySelector('parseerror');
    if (parseError) return null;

    // Topic — find any element whose local-name is 'Topic'
    let topic = '';
    const allEls = doc.getElementsByTagName('*');
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      if (el.localName === 'Topic') {
        topic = (el.textContent ?? '').trim();
        break;
      }
    }
    if (!topic) return null;

    // UtcTime from Message element
    let utcTime = new Date().toISOString();
    let operation = 'Changed';
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      if (el.localName === 'Message') {
        utcTime   = el.getAttribute('UtcTime')          ?? utcTime;
        operation = el.getAttribute('PropertyOperation') ?? operation;
        break;
      }
    }

    // SimpleItem key/value pairs
    const items: Record<string, string> = {};
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      if (el.localName === 'SimpleItem') {
        const name  = el.getAttribute('Name');
        const value = el.getAttribute('Value');
        if (name !== null) items[name] = value ?? '';
      }
    }

    return {
      topic,
      topicLabel: TOPIC_LABELS[topic] ?? (topic.split('/').pop() ?? 'Event'),
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

export { TOPIC_LABELS };
