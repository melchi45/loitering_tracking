'use strict';

const {
  extractRtspResponseText,
  parseSdpVideoTrack,
  rtpPayload,
  classifyH264RtpPacket,
  classifyH265RtpPacket,
  classifyVideoRtpPacket,
} = require('./rtspOverWebSocketServer');

function rtpPacket(payloadBytes, { cc = 0, extension = false } = {}) {
  const header = Buffer.alloc(12 + cc * 4);
  header[0] = 0x80 | (extension ? 0x10 : 0) | cc;
  header[1] = 0x60; // no marker, PT=96
  header.writeUInt16BE(1, 2);
  header.writeUInt32BE(1000, 4);
  header.writeUInt32BE(12345, 8);
  return Buffer.concat([header, Buffer.from(payloadBytes)]);
}

function lengthPrefixed(nal) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(nal.length, 0);
  return Buffer.concat([len, nal]);
}

// H.265's NAL header is 2 bytes: byte0 = (forbidden<<7)|(type<<1)|(layerIdHigh),
// byte1 = (layerIdLow<<3)|tidPlus1. layer_id=0, temporal_id_plus1=1 (the
// minimum legal value) for all test fixtures below.
function h265NalHeader(nalType) {
  return Buffer.from([(nalType << 1) & 0xff, 0x01]);
}

function h265Packet(nalType, extra = []) {
  return Buffer.concat([h265NalHeader(nalType), Buffer.from(extra)]);
}

function h265FuPacket(fragType, { start = true, end = false } = {}) {
  const fuHeaderByte = ((start ? 1 : 0) << 7) | ((end ? 1 : 0) << 6) | (fragType & 0x3f);
  return Buffer.concat([h265NalHeader(49), Buffer.from([fuHeaderByte, 0xaa, 0xbb])]);
}

describe('rtspOverWebSocketServer.rtpPayload', () => {
  test('returns the payload after the fixed 12-byte header', () => {
    const packet = rtpPacket([0x67, 0xaa, 0xbb]);
    expect(rtpPayload(packet)).toEqual(Buffer.from([0x67, 0xaa, 0xbb]));
  });

  test('skips CSRC entries counted by the CC nibble', () => {
    const packet = rtpPacket([0x65, 0x01], { cc: 2 });
    expect(rtpPayload(packet)).toEqual(Buffer.from([0x65, 0x01]));
  });

  test('returns null for a packet shorter than its own fixed header', () => {
    expect(rtpPayload(Buffer.alloc(8))).toBeNull();
  });
});

describe('rtspOverWebSocketServer.classifyH264RtpPacket', () => {
  test('drops a single-NAL non-IDR slice (type 1) and does not open the gate', () => {
    const packet = rtpPacket([0x41, 0xaa, 0xbb]); // ref_idc=2, type=1
    expect(classifyH264RtpPacket(packet)).toEqual({ forward: false, opensGate: false });
  });

  test('forwards a single-NAL IDR slice (type 5) and opens the gate', () => {
    const packet = rtpPacket([0x65, 0xaa, 0xbb]); // ref_idc=3, type=5
    expect(classifyH264RtpPacket(packet)).toEqual({ forward: true, opensGate: true });
  });

  test('forwards SPS (type 7) without opening the gate', () => {
    const packet = rtpPacket([0x67, 0x01, 0x02, 0x03]);
    expect(classifyH264RtpPacket(packet)).toEqual({ forward: true, opensGate: false });
  });

  test('STAP-A aggregate carrying SPS+PPS+IDR opens the gate', () => {
    const sps = Buffer.from([0x67, 0x01, 0x02]);
    const pps = Buffer.from([0x68, 0x03]);
    const idr = Buffer.from([0x65, 0x04, 0x05, 0x06]);
    const stapPayload = Buffer.concat([
      Buffer.from([0x78]), // STAP-A indicator, type=24
      lengthPrefixed(sps),
      lengthPrefixed(pps),
      lengthPrefixed(idr),
    ]);
    const packet = rtpPacket(stapPayload);
    expect(classifyH264RtpPacket(packet)).toEqual({ forward: true, opensGate: true });
  });

  test('STAP-A aggregate carrying only SPS+PPS does not open the gate', () => {
    const sps = Buffer.from([0x67, 0x01, 0x02]);
    const pps = Buffer.from([0x68, 0x03]);
    const stapPayload = Buffer.concat([Buffer.from([0x78]), lengthPrefixed(sps), lengthPrefixed(pps)]);
    const packet = rtpPacket(stapPayload);
    expect(classifyH264RtpPacket(packet)).toEqual({ forward: true, opensGate: false });
  });

  test('FU-A fragment of a non-IDR slice (frag type 1) is dropped', () => {
    const packet = rtpPacket([0x7c, 0x81, 0xaa, 0xbb]); // FU indicator type=28, FU header S=1/type=1
    expect(classifyH264RtpPacket(packet)).toEqual({ forward: false, opensGate: false });
  });

  test('FU-A fragment of an IDR slice (frag type 5) forwards and opens the gate', () => {
    const packet = rtpPacket([0x7c, 0x85, 0xaa, 0xbb]); // FU header S=1/type=5
    expect(classifyH264RtpPacket(packet)).toEqual({ forward: true, opensGate: true });
  });

  test('fails open (forward, no gate) for an empty or unparsable payload', () => {
    const tooShort = Buffer.alloc(12); // fixed header only, zero-length payload
    expect(classifyH264RtpPacket(tooShort)).toEqual({ forward: true, opensGate: false });
  });
});

describe('rtspOverWebSocketServer.extractRtspResponseText', () => {
  test('returns null when the header terminator has not arrived yet', () => {
    const partial = Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 2\r\n');
    expect(extractRtspResponseText(partial)).toBeNull();
  });

  test('returns null when Content-Length bytes have not fully arrived yet', () => {
    const partial = Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Length: 10\r\n\r\nabc');
    expect(extractRtspResponseText(partial)).toBeNull();
  });

  test('parses a zero-body response and reports exact bytes consumed', () => {
    const text = 'RTSP/1.0 200 OK\r\nCSeq: 3\r\nSession: abc123\r\n\r\n';
    const buf = Buffer.from(text);
    const result = extractRtspResponseText(buf);
    expect(result).not.toBeNull();
    expect(result.consumed).toBe(buf.length);
    expect(result.body).toBe('');
    expect(result.raw).toEqual(buf);
  });

  test('parses a response with a Content-Length body and leaves trailing bytes unconsumed', () => {
    const body = 'v=0\r\ns=stream\r\n';
    const text = `RTSP/1.0 200 OK\r\nCSeq: 4\r\nContent-Length: ${body.length}\r\n\r\n${body}TRAILING`;
    const buf = Buffer.from(text);
    const result = extractRtspResponseText(buf);
    expect(result).not.toBeNull();
    expect(result.body).toBe(body);
    expect(buf.slice(result.consumed).toString()).toBe('TRAILING');
  });
});

describe('rtspOverWebSocketServer.parseSdpVideoTrack', () => {
  test('extracts the video control and confirms H264 from rtpmap', () => {
    const sdp = [
      'v=0',
      's=stream',
      'm=video 0 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      'a=control:trackID=1',
      'm=audio 0 RTP/AVP 97',
      'a=rtpmap:97 mpeg4-generic/16000',
      'a=control:trackID=2',
    ].join('\r\n');
    expect(parseSdpVideoTrack(sdp)).toEqual({ control: 'trackID=1', codec: 'H264' });
  });

  test('extracts the video control and confirms H265 from rtpmap', () => {
    const sdp = ['m=video 0 RTP/AVP 96', 'a=rtpmap:96 H265/90000', 'a=control:trackID=1'].join('\r\n');
    expect(parseSdpVideoTrack(sdp)).toEqual({ control: 'trackID=1', codec: 'H265' });
  });

  test('recognizes the HEVC rtpmap name as H265 too', () => {
    const sdp = ['m=video 0 RTP/AVP 96', 'a=rtpmap:96 HEVC/90000', 'a=control:trackID=1'].join('\r\n');
    expect(parseSdpVideoTrack(sdp)).toEqual({ control: 'trackID=1', codec: 'H265' });
  });

  test('returns null when the video track is neither H264 nor H265', () => {
    const sdp = ['m=video 0 RTP/AVP 26', 'a=rtpmap:26 JPEG/90000', 'a=control:trackID=1'].join('\r\n');
    expect(parseSdpVideoTrack(sdp)).toBeNull();
  });

  test('returns null when there is no video media block', () => {
    const sdp = ['m=audio 0 RTP/AVP 97', 'a=rtpmap:97 mpeg4-generic/16000', 'a=control:trackID=1'].join('\r\n');
    expect(parseSdpVideoTrack(sdp)).toBeNull();
  });
});

describe('rtspOverWebSocketServer.classifyH265RtpPacket', () => {
  test('drops a single-NAL non-IRAP slice (type 1, TRAIL_R) and does not open the gate', () => {
    const packet = rtpPacket(h265Packet(1, [0xaa, 0xbb]));
    expect(classifyH265RtpPacket(packet)).toEqual({ forward: false, opensGate: false });
  });

  test('forwards a single-NAL IDR (type 19, IDR_W_RADL) and opens the gate', () => {
    const packet = rtpPacket(h265Packet(19, [0xaa, 0xbb]));
    expect(classifyH265RtpPacket(packet)).toEqual({ forward: true, opensGate: true });
  });

  test('forwards VPS/SPS/PPS (types 32/33/34) without opening the gate', () => {
    for (const type of [32, 33, 34]) {
      const packet = rtpPacket(h265Packet(type, [0x01, 0x02]));
      expect(classifyH265RtpPacket(packet)).toEqual({ forward: true, opensGate: false });
    }
  });

  test('Aggregation Packet carrying VPS+SPS+PPS+IDR opens the gate', () => {
    const vps = h265Packet(32, [0x01]);
    const sps = h265Packet(33, [0x02]);
    const pps = h265Packet(34, [0x03]);
    const idr = h265Packet(19, [0x04, 0x05]);
    const apPayload = Buffer.concat([
      h265NalHeader(48), // AP's own NAL header
      lengthPrefixed(vps),
      lengthPrefixed(sps),
      lengthPrefixed(pps),
      lengthPrefixed(idr),
    ]);
    const packet = rtpPacket(apPayload);
    expect(classifyH265RtpPacket(packet)).toEqual({ forward: true, opensGate: true });
  });

  test('Aggregation Packet carrying only VPS+SPS+PPS does not open the gate', () => {
    const vps = h265Packet(32, [0x01]);
    const sps = h265Packet(33, [0x02]);
    const pps = h265Packet(34, [0x03]);
    const apPayload = Buffer.concat([h265NalHeader(48), lengthPrefixed(vps), lengthPrefixed(sps), lengthPrefixed(pps)]);
    const packet = rtpPacket(apPayload);
    expect(classifyH265RtpPacket(packet)).toEqual({ forward: true, opensGate: false });
  });

  test('Fragmentation Unit fragment of a non-IRAP slice (frag type 1) is dropped', () => {
    const packet = rtpPacket(h265FuPacket(1));
    expect(classifyH265RtpPacket(packet)).toEqual({ forward: false, opensGate: false });
  });

  test('Fragmentation Unit fragment of an IDR (frag type 19) forwards and opens the gate', () => {
    const packet = rtpPacket(h265FuPacket(19));
    expect(classifyH265RtpPacket(packet)).toEqual({ forward: true, opensGate: true });
  });

  test('fails open (forward, no gate) for a payload too short to hold a NAL header', () => {
    const tooShort = Buffer.alloc(13); // fixed header + 1 byte of payload
    expect(classifyH265RtpPacket(tooShort)).toEqual({ forward: true, opensGate: false });
  });
});

describe('rtspOverWebSocketServer.classifyVideoRtpPacket', () => {
  test('dispatches to the H264 classifier for codec H264', () => {
    const packet = rtpPacket([0x65, 0xaa, 0xbb]); // H.264 IDR
    expect(classifyVideoRtpPacket('H264', packet)).toEqual({ forward: true, opensGate: true });
  });

  test('dispatches to the H265 classifier for codec H265', () => {
    const packet = rtpPacket(h265Packet(19, [0xaa, 0xbb])); // H.265 IDR
    expect(classifyVideoRtpPacket('H265', packet)).toEqual({ forward: true, opensGate: true });
  });
});
