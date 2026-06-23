# DESIGN DOCUMENT
# ONVIF Metadata Pipeline — RTSP App RTP → Camera Events

| | |
|---|---|
| **Document ID** | DESIGN-LTS-ONVIF-01 |
| **Version** | 1.2 |
| **Status** | Active |
| **Date** | 2026-06-16 |
| **Related** | [Design_DataChannel_CameraEvents.md](Design_DataChannel_CameraEvents.md) · [Design_WebRTC_Engine_Modes.md](Design_WebRTC_Engine_Modes.md) · [Design_RTSP_Capture_Backend.md](Design_RTSP_Capture_Backend.md) |

---

## 1. 개요

RTSP 스트림에는 비디오·오디오 트랙 외에 **application/data 트랙**이 포함될 수 있습니다.  
Samsung IP 카메라는 이 트랙에 **ONVIF MetadataStream XML**을 실어 보냅니다.  
본 문서는 해당 트랙의 수집, 서버 라우팅, 브라우저 표시까지 전체 파이프라인을 기술합니다.

---

## 2. ONVIF MetadataStream 구조

Samsung IP 카메라가 RTSP App RTP 트랙으로 전달하는 XML 예시:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream
    xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
    xmlns:tns1="http://www.onvif.org/ver10/topics"
    xmlns:tnssamsung="http://www.samsungcctv.com/2011/event/topics">
  <tt:Event>
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">
        tns1:Device/tns1:Trigger/CallRequest
      </wsnt:Topic>
      <wsnt:Message>
        <tt:Message UtcTime="2026-06-16T05:57:28.592Z" PropertyOperation="Changed">
          <tt:Source>
            <tt:SimpleItem Name="SourceToken" Value="CallRequest-1"/>
          </tt:Source>
          <tt:Data>
            <tt:SimpleItem Name="State" Value="false"/>
          </tt:Data>
        </tt:Message>
      </wsnt:Message>
    </wsnt:NotificationMessage>
  </tt:Event>
</tt:MetadataStream>
```

### 2.1 네임스페이스

| 프리픽스 | URI | 의미 |
|---------|-----|------|
| `tt` | `http://www.onvif.org/ver10/schema` | ONVIF Core 스키마 |
| `wsnt` | `http://docs.oasis-open.org/wsn/b-2` | WS-Notification (OASIS 표준) |
| `tns1` | `http://www.onvif.org/ver10/topics` | ONVIF 표준 이벤트 토픽 |
| `tnssamsung` | `http://www.samsungcctv.com/2011/event/topics` | Samsung 전용 확장 토픽 |

### 2.2 주요 이벤트 토픽

| Topic | 의미 | State 값 |
|-------|------|---------|
| `tns1:Device/tns1:Trigger/CallRequest` | 물리 콜 버튼(초인종) 이벤트 | `true`=누름, `false`=해제 |
| `tns1:VideoSource/tns1:MotionAlarm` | 모션 감지 | `true`=감지, `false`=해제 |
| `tns1:AudioAnalytics/tns1:Audio/tns1:DetectedSound` | 오디오 감지 (표준) | `true`=감지 |
| `tns1:AudioAnalytics/tns1:Audio/tns1:AudioAlarm` | 오디오 알람 (표준) | `true`=알람 |
| `tns1:VideoSource/tns1:GlobalSceneChange/*` | 탬퍼링 (블러/밝기/어둠) | `true`=탬퍼 |
| `tns1:VideoAnalytics/tns1:Line/tns1:Crossed` | 라인 크로싱 | `true`=크로싱 |
| `tns1:VideoAnalytics/tns1:Field/tns1:Entered` | 영역 진입 | `true`=진입 |
| `tns1:VideoAnalytics/tns1:Field/tns1:Exited` | 영역 이탈 | `true`=이탈 |
| `tns1:RuleEngine/tns1:LineDetector/tns1:Crossed` | 라인 크로싱 (RuleEngine) | `true`=크로싱 |
| `tnssamsung:IVA/Fire` | 화재 감지 | `true`=감지 |
| `tnssamsung:IVA/Smoke` | 연기 감지 | `true`=감지 |
| `tnssamsung:IVA/ObjectDetection` | 객체 감지 | `true`=감지 |
| `tnssamsung:IVA/LoiteringDetection` | 배회 감지 | `true`=감지 |
| `tnssamsung:IVA/AudioDetection` | 오디오 감지 (Samsung IVA) | `true`=감지 |
| `tnssamsung:IVA/LineCrossing` | 라인 크로싱 (Samsung) | `true`=크로싱 |
| `tnssamsung:AudioAlarm` / `tnssamsung:AudioDetection` | 오디오 알람 (Samsung) | `true`=알람 |
| 위 목록 외 미인식 Topic | unknown → 전체 topic 경로를 topicType으로 저장 | 해당 있으면 state 추출 |

**State 추출 우선순위** (`onvifParser.js extractState()`):
`State` → `IsMotion` → `IsSoundDetected` → `IsAlarm` → `IsActive` → `Active` → `Enabled` → `IsEnabled` → `IsTriggered` → `IsDetected` → `Value` → (마지막 수단) token/channel이 아닌 첫 번째 boolean 값

---

## 3. RTSP App RTP 트랙 특성

Samsung IP 카메라의 RTSP DESCRIBE 응답에는 세 번째 트랙이 포함됩니다:

```
m=video ...     → H.264 영상
m=audio ...     → G.711 / G.726 / AAC 오디오
m=application . → ONVIF MetadataStream (PyAV: type=data, codec=unknown)
```

- **RTP Payload Type**: 동적 할당 (PT 96~127 범위)
- **패킷 속도**: 약 33~38 패킷/초 (Samsung 카메라 기준)
- **패킷당 페이로드**: ONVIF XML 한 개 이벤트 (수십~수백 바이트)
- PyAV에서는 `stream.type not in ("video", "audio")`로 필터링

---

## 4. 데이터 파이프라인

```
Samsung IP 카메라 RTSP 스트림
  │  Application/Data RTP 트랙 (PT 96+, ONVIF MetadataStream XML)
  ▼
ingest_daemon.py — _app_rtp_ingest_once()
  │  PyAV demux → packet bytes → base64 인코딩
  │  POST https://{server}/api/internal/apprtp/{cameraId}
  │  Body: { pt, timestamp, seq, payload(base64) }
  ▼
server/src/routes/internalApi.js
  │  POST /api/internal/apprtp/:cameraId
  ├──► io.emit('appRtp', { cameraId, pt, timestamp, seq, payload })
  │        └─ Socket.IO broadcast → 모든 연결된 클라이언트
  │
  └──► mediasoupEngine.sendAppRtp(cameraId, data)    [WEBRTC_ENGINE=mediasoup 시]
           └─ cam.dataProducer.send(JSON)
               └─ DirectTransport → DataConsumer → 브라우저 DataChannel
  ▼
client — useWebRTC.ts (별도 useEffect)
  │  socket.on('appRtp', handler)  ← Socket.IO fallback (모든 엔진 모드 공통)
  │  pc.ondatachannel → dc.onmessage ← DataChannel (mediasoup 모드 추가 경로)
  │  pushDCMessage({ cameraId, pt, timestamp, seq, payload })
  ▼
dataChannelStore.ts (Zustand)
  │  seq 기반 dedup → 중복 제거 (_lastSeqs)
  │  history (최근 100개, 200ms 스로틀)
  ▼
FullscreenCameraView.tsx — CameraEventsTab
  │  base64 decode → UTF-8 텍스트 → 200자 truncate
  └─ 화면 표시
```

---

## 5. ingest-daemon App RTP 구현

**파일**: `ingest-daemon/ingest_daemon.py`

### 5.1 스레드 시작 조건

```python
if self.app_rtp_callback_url:
    self._start_thread("apprtp", self._app_rtp_loop)
```

`mediasoupEngine.js`의 `addCameraStream()` 및 `reregisterAllWithIngest()`가 항상  
`appRtpCallbackUrl: ${base}/api/internal/apprtp/${cameraId}`를 전달합니다.

### 5.2 재시도 루프 (`_app_rtp_loop`)

```python
def _app_rtp_loop(self):
    retry_delay = 2.0
    while not self._stop.is_set():
        try:
            self._app_rtp_ingest_once()
            retry_delay = 2.0
        except RuntimeError as exc:
            if "No application stream" in str(exc):
                return          # 해당 카메라에 App 트랙 없음 — 조용히 종료
            raise
        except Exception as exc:
            self._stop.wait(retry_delay)
            retry_delay = min(retry_delay * 1.5, 30.0)  # 지수 백오프, 최대 30s
```

### 5.3 단일 수집 (`_app_rtp_ingest_once`)

```python
def _app_rtp_ingest_once(self):
    inp = av.open(self.rtsp_url, options=_RTSP_OPTIONS, timeout=10)
    app_streams = [s for s in inp.streams if s.type not in ("video", "audio")]
    if not app_streams:
        raise RuntimeError("No application stream")
    ds = app_streams[0]
    seq = 0
    for pkt in inp.demux(ds):
        payload_b64 = base64.b64encode(bytes(pkt)).decode("ascii")
        body = json.dumps({
            "pt":        ds.index,
            "timestamp": int(pkt.pts or 0),
            "seq":       seq,
            "payload":   payload_b64,
        }).encode()
        urlopen(Request(self.app_rtp_callback_url, data=body,
                        headers={"Content-Type":"application/json"}, method="POST"),
                timeout=1, context=ctx)
        seq += 1
```

---

## 6. 서버 라우팅 (`internalApi.js`)

```javascript
router.post('/apprtp/:cameraId', express.json({ limit: '64kb' }), (req, res) => {
  const { cameraId } = req.params;
  const data = req.body;

  // 1. Socket.IO broadcast (모든 WEBRTC_ENGINE 모드)
  if (_io) _io.emit('appRtp', { cameraId, ...data });

  // 2. mediasoup DataProducer (WEBRTC_ENGINE=mediasoup 전용)
  try {
    const { getEngine, WEBRTC_ENGINE } = require('../services/webrtcEngineFactory');
    if (WEBRTC_ENGINE === 'mediasoup' && typeof getEngine().sendAppRtp === 'function') {
      getEngine().sendAppRtp(cameraId, data);
    }
  } catch (err) {
    console.error('[internalApi] sendAppRtp error:', err.message);
  }

  res.sendStatus(200);
});
```

> ⚠️ **이전 버그**: `require('../webrtcEngineFactory')`(경로 오류)로 인해 mediasoup  
> DataProducer로 전달되지 않던 문제가 2026-06-16 수정됨.  
> 수정 내역: `'../webrtcEngineFactory'` → `'../services/webrtcEngineFactory'`

---

## 7. 클라이언트 수신 (`useWebRTC.ts`)

### 7.1 Socket.IO 리스너 (별도 useEffect — 모든 케이스 공통)

```typescript
useEffect(() => {
  if (!enabled || !cameraId || !socket) return;
  const handleAppRtp = (data) => {
    if (data.cameraId !== cameraId) return;
    pushDCMessage({ cameraId, ...data });
  };
  socket.on('appRtp', handleAppRtp);
  return () => socket.off('appRtp', handleAppRtp);
}, [cameraId, enabled, socket, pushDCMessage]);
```

### 7.2 DataChannel 수신 (WEBRTC_ENGINE=mediasoup 추가 경로)

```typescript
pc.ondatachannel = (event) => {
  const dc = event.channel;
  dc.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    pushDCMessage({ cameraId, ...msg });
  };
};
```

### 7.3 중복 제거 (`dataChannelStore.ts`)

Socket.IO와 DataChannel이 동일 패킷을 동시에 전달하는 경우 `seq` 기반으로 dedup:

```typescript
const lastSeq = s._lastSeqs[msg.cameraId] ?? -1;
if (msg.seq <= lastSeq) return s;  // 이미 처리된 패킷 → 상태 변경 없음
```

---

## 8. 향후 확장: ONVIF 구조화 파싱

현재는 base64 raw bytes를 그대로 브라우저에 전달합니다. 향후 서버에서 구조화 파싱을 추가하면:

```javascript
// server/src/services/onvifMetadataParser.js (미구현 — 향후 계획)
const { XMLParser } = require('fast-xml-parser');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function parseOnvifEvent(base64Payload) {
  const xml = Buffer.from(base64Payload, 'base64').toString('utf-8');
  if (!xml.includes('MetadataStream')) return null;
  const obj = parser.parse(xml);
  const msg = obj?.['tt:MetadataStream']?.['tt:Event']
                ?.['wsnt:NotificationMessage'];
  if (!msg) return null;
  return {
    topic:     msg['wsnt:Topic']?.['#text'] ?? msg['wsnt:Topic'],
    utcTime:   msg['wsnt:Message']?.['tt:Message']?.['@_UtcTime'],
    operation: msg['wsnt:Message']?.['tt:Message']?.['@_PropertyOperation'],
    source:    msg['wsnt:Message']?.['tt:Message']?.['tt:Source']
                 ?.['tt:SimpleItem']?.['@_Value'],
    state:     msg['wsnt:Message']?.['tt:Message']?.['tt:Data']
                 ?.['tt:SimpleItem']?.['@_Value'],
  };
}
```

구조화 파싱 완료 시 `alertService.js`와 연동하여:
- `CallRequest state=true` → 즉시 Alert 생성
- `MotionAlarm state=true` → 배회 분석 보조 신호 제공

---

## 9. 열상 카메라 — Radiometry BoxTemperatureReading (v1.2)

### 9.1 XML 구조

열상 카메라는 `tns1:VideoAnalytics/Radiometry/BoxTemperatureReading` 토픽으로 온도 데이터를 주기적으로 전송합니다.

```xml
<tt:MetadataStream xmlns:ttr="https://www.onvif.org/ver20/analytics/radiometry" ...>
  <tt:Event>
    <wsnt:NotificationMessage>
      <wsnt:Topic ...>tns1:VideoAnalytics/Radiometry/BoxTemperatureReading</wsnt:Topic>
      <wsnt:Message><tt:Message UtcTime="2026-04-19T21:32:08.104Z">
        <tt:Data><tt:ElementItem Name="Reading">
          <ttr:BoxTemperatureReading ItemID="D" AreaName="D"
            MaxTemperature="352.5" MaxTemperatureCoordinatesX="243" MaxTemperatureCoordinatesY="217"
            MinTemperature="329.6" MinTemperatureCoordinatesX="328" MinTemperatureCoordinatesY="261"
            AverageTemperature="343.5"/>
        </tt:ElementItem></tt:Data>
      </tt:Message></wsnt:Message>
    </wsnt:NotificationMessage>
  </tt:Event>
</tt:MetadataStream>
```

### 9.2 서버 파싱 — `parseRadiometryReadings()` (`onvifParser.js`)

`parseOnvifPayload()` 내부에서 `BoxTemperatureReading`이 감지되면 `parseRadiometryReadings(xml)`을 호출합니다:

```js
// 반환 구조 (readings 배열)
{
  itemId:   "D",
  areaName: "D",
  maxTemp:  352.5, maxTempX: 243, maxTempY: 217,
  minTemp:  329.6, minTempX: 328, minTempY: 261,
  avgTemp:  343.5
}
```

### 9.3 Socket.IO 이벤트 — `onvif:temperature`

Radiometry 읽기는 **state-dedup 제외** — 같은 값이 반복되어도 매번 브로드캐스트합니다.

```
internalApi.js POST /apprtp/:cameraId
  → parseOnvifPayload() → parsed.radiometry
  → _io.emit('onvif:temperature', { cameraId, utcTime, readings })  ← dedup 전 즉시 방출
  → (이후) dedup 체크 → onvif_events 저장 (state 변화 시만)
```

DB에는 저장하지 않습니다 — 실시간 스트리밍 전용입니다.

### 9.4 클라이언트 오버레이 — `ThermalOverlay.tsx`

`ThermalOverlay`는 `CameraView` 안에 항상 마운트(`pointer-events-none`)되어 `onvif:temperature` 이벤트를 수신합니다.

#### 9.4.1 FullArea 판별

| 조건 | 표시 방식 |
|---|---|
| `AreaName="FullArea"` 또는 `ItemID="Z"` | **상단 배너** — crosshair 없음, 전체 프레임 온도 요약 |
| 그 외 특정 좌표 영역 | SVG **crosshair** (red=최고, sky-blue=최저) + 좌하단 정보 패널 |

두 유형이 동시에 존재하면 모두 표시됩니다.

#### 9.4.2 좌표 매핑

카메라 픽셀 좌표 → 화면 좌표는 `getRenderArea()` 레터박스 보정 알고리즘을 사용합니다 (CameraView detection overlay와 동일):

```ts
function toScreen(px, py, fw, fh, cw, ch) {
  const { rw, rh, ox, oy } = getRenderArea(fw, fh, cw, ch);
  return { sx: ox + (px / fw) * rw, sy: oy + (py / fh) * rh };
}
```

#### 9.4.3 온도 단위 heuristic

| 값 범위 | 해석 | 표시 형식 |
|---|---|---|
| > 200 | Kelvin (FLIR 계열) | `352.5 (79.4°C)` |
| ≤ 200 | Celsius | `79.4°C` |

#### 9.4.4 Fade 타이머

6초간 `onvif:temperature` 수신 없으면 오버레이 자동 소멸 (`FADE_MS = 6000`).

---

## 10. 관련 파일

| 파일 | 역할 |
|------|------|
| `ingest-daemon/ingest_daemon.py` | `_app_rtp_loop()`, `_app_rtp_ingest_once()` |
| `server/src/routes/internalApi.js` | `POST /api/internal/apprtp/:cameraId` — `onvif:temperature` 방출 |
| `server/src/services/onvifParser.js` | `parseOnvifPayload()`, `parseRadiometryReadings()`, `TOPIC_MAP` |
| `server/src/services/webrtc/mediasoupEngine.js` | `sendAppRtp()`, `dataProducer.send()` |
| `client/src/hooks/useWebRTC.ts` | Socket.IO `appRtp` 리스너 |
| `client/src/stores/dataChannelStore.ts` | seq dedup, history 관리 |
| `client/src/components/FullscreenCameraView.tsx` | `CameraEventsTab` — decodePayload() |
| `client/src/components/ThermalOverlay.tsx` | `onvif:temperature` 실시간 수신 · FullArea 배너 · 좌표 crosshair |
| `client/src/components/CameraView.tsx` | `<ThermalOverlay>` 마운트 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — RTSP App RTP ONVIF 메타데이터 파이프라인 전체 기술 |
| 1.1 | 2026-06-22 | TOPIC_MAP 대폭 확장 (AudioAlarm·Tamper·Samsung IVA 계열), extractState() 다중 item 이름 지원, unknown topic은 full path를 topicType으로 저장 |
| 1.2 | 2026-06-23 | 열상 카메라 Radiometry 섹션 추가 — BoxTemperatureReading 파싱, onvif:temperature 소켓 이벤트, ThermalOverlay (FullArea 배너 + 좌표 crosshair) |
