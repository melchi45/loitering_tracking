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
| `tns1:VideoSource/tns1:MotionAlarm` | 모션 감지 (표준) | `true`=감지, `false`=해제 |
| `tns1:VideoSource/MotionAlarm` | 모션 감지 (namespace 없는 Samsung 변형) | `true`=감지, `false`=해제 |
| `tns1:VideoAnalytics/tnssamsung:MotionDetection` | 모션 감지 (Samsung VideoAnalytics) | `1`=감지, `0`=해제 |
| `tns1:AudioAnalytics/tns1:Audio/tns1:DetectedSound` | 오디오 감지 (표준) | `true`=감지 |
| `tns1:AudioAnalytics/tns1:Audio/tns1:AudioAlarm` | 오디오 알람 (표준) | `true`=알람 |
| `tns1:AudioSource/tnssamsung:AudioDetection` | 오디오 감지 (Samsung AudioSource 경로) | `true`=감지 |
| `tns1:VideoSource/tns1:GlobalSceneChange/*` | 탬퍼링 (블러/밝기/어둠) | `true`=탬퍼 |
| `tns1:VideoAnalytics/tns1:Line/tns1:Crossed` | 라인 크로싱 | `true`=크로싱 |
| `tns1:VideoAnalytics/tns1:Field/tns1:Entered` | 영역 진입 | `true`=진입 |
| `tns1:VideoAnalytics/tns1:Field/tns1:Exited` | 영역 이탈 | `true`=이탈 |
| `tns1:RuleEngine/tns1:LineDetector/tns1:Crossed` | 라인 크로싱 (RuleEngine) | `true`=크로싱 |
| `tns1:VideoSource/RadiometryAlarm` | 열상 방사측정 알람 | state 없음 (포인트 이벤트) |
| `tns1:RuleEngine/Radiometry/TemperatureAlarm` | 온도 알람 (RuleEngine) | state 없음 (포인트 이벤트) |
| `tns1:RuleEngine/Detection/TemperatureDifference` | 온도 차이 감지 | state 없음 (포인트 이벤트) |
| `tns1:Device/tns1:Trigger/tns1:DigitalInput` | 디지털 입력 (표준) | `true`=활성 |
| `tns1:Device/tns1:Trigger/tnssamsung:DigitalInput` | 디지털 입력 (Samsung namespace 변형) | `true`=활성 |
| `tns1:Device/tns1:Trigger/tns1:Relay` | 릴레이 출력 | `inactive`/`active` |
| `tns1:Device/tns1:HardwareFailure/tns1:StorageFailure` | 스토리지 오류 | `true`=오류 |
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
- **패킷당 페이로드**: 단일 MetadataStream XML (수십~수백 바이트). 내부에 여러 `NotificationMessage` 블록이 포함될 수 있음 — `parseOnvifPayload()`가 블록별로 개별 파싱하여 배열로 반환
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
    # timeout 옵션을 av.open() 시점에 전달 (AVFormatContext.io_timeout in µs).
    # PyAV 버전에 따라 av.open() 이후 inp.read_timeout = N 속성 쓰기가
    # AttributeError를 발생시킬 수 있으므로, av.open()에 옵션으로 전달한다.
    #
    # app_rtp_rtsp_url: MediaMTX 경유 시 원본 카메라 URL 사용 (§5.5 참조).
    _app_rtp_opts = {**_RTSP_OPTIONS, "timeout": str(int(APP_RTP_READ_TIMEOUT * 1_000_000))}
    inp = av.open(self.app_rtp_rtsp_url, options=_app_rtp_opts)
    try:
        app_streams = [s for s in inp.streams if s.type not in ("video", "audio")]
        if not app_streams:
            raise RuntimeError("No application stream")
        ds = app_streams[0]
        seq = 0
        for pkt in inp.demux(ds):
            if self._stop.is_set():
                break
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
    finally:
        try:
            inp.close()
        except Exception:
            pass
```

### 5.5 MediaMTX 환경 — App RTP URL 분리 (v1.6)

MediaMTX를 RTSP 프록시로 사용하는 경우(`mediamtxReady=true`), `pipelineManager.js`는 AI 캡처 URL을 MediaMTX 재전송 URL(`rtsp://127.0.0.1:8554/{uuid}`)로 설정합니다.

**문제**: MediaMTX는 video/audio 트랙만 재전송하며 ONVIF data 트랙을 제거합니다.  
ingest-daemon이 MediaMTX URL로 App RTP를 시도하면:
- 데이터 트랙이 없어 `RuntimeError("No application stream")` 발생
- PyAV/libav가 내부 소켓을 바인드하려 할 때 `[Errno 98] EADDRINUSE` 발생
- ONVIF 이벤트/온도 데이터가 서버에 전달되지 않음

**해결**: `appRtpRtspUrl` 필드를 추가해 AI 경로(MediaMTX)와 App RTP 경로(원본 카메라)를 분리합니다.

```python
# CameraSession.__init__
self.rtsp_url          = cfg["rtspUrl"]          # AI: MediaMTX URL (or direct)
self.app_rtp_rtsp_url  = cfg.get("appRtpRtspUrl",
                                  cfg["rtspUrl"]) # AppRTP: 원본 카메라 URL
```

```javascript
// pipelineManager.js (mediamtxReady=true 경우)
const daemonRtspUrl       = captureUrl;           // MediaMTX URL → AI
const daemonAppRtpRtspUrl = rtspUrl;              // 원본 카메라 URL → App RTP
body.appRtpCallbackUrl = appRtpCallbackUrl;
body.appRtpRtspUrl     = daemonAppRtpRtspUrl;
```

이 분리로:
- AI 캡처는 MediaMTX 단일 소비자 모델을 유지 (카메라 동시 연결 수 제한 준수)
- ONVIF 메타데이터 수집은 카메라에 직접 별도 RTSP 세션으로 연결

#### EADDRINUSE 방어 처리

`_app_rtp_rtsp_url`이 올바른 원본 URL이더라도, 카메라가 ONVIF data 트랙을 아예 갖지 않는 경우를 위해 방어 처리를 추가합니다:

```python
except OSError as exc:
    if exc.errno == 98:  # EADDRINUSE
        addr_in_use_n += 1
        if addr_in_use_n >= 3:
            log.warning("[%s] App RTP: persistent EADDRINUSE (%d) — "
                        "source does not carry a data track; exiting", ...)
            return
```

---

### 5.4 PyAV 버전 호환성 — timeout 옵션 전달 방식

| PyAV 버전 범주 | `inp.read_timeout = N` | `av.open(options={"timeout": N})` |
|---|---|---|
| 구 버전 (≤ 9.x 일부) | 쓰기 가능 | 지원됨 |
| 신 버전 (10+) | `AttributeError: not writable` | **지원됨 (유일한 방법)** |

`"timeout"` 옵션은 FFmpeg `AVFormatContext.io_timeout`에 매핑되며, RTSP keepalive(OPTIONS/GET_PARAMETER) 수신과 무관하게 진짜 데이터 비수신 시에만 타임아웃을 발생시킨다. `stimeout`(소켓 타임아웃)은 keepalive에 의해 리셋되므로 ONVIF 메타데이터 스트림에 적합하지 않다.

**버그 이력 (2026-06-23):**
- 증상: `App RTP error: attribute 'read_timeout' of 'av.container.core.Container' objects is not writable` 로그 반복, 이어서 `maximum reader count reached` → `Server returned 400 Bad Request`
- 원인: 연쇄 실패 — ① `inp.read_timeout = N`이 `AttributeError`로 즉시 실패 → ② `try` 블록 이전이라 `finally: inp.close()` 미호출 → ③ PyAV 레퍼런스 카운트 기반 GC가 컨테이너를 닫기까지 수 초 지연 → ④ MediaMTX i/o timeout(~7-10s) 전까지 좀비 RTSP 세션 잔존 → ⑤ 5초 재시도 루프로 세션 누적 → `maxReaders: 10` 초과
- 수정: `_RTSP_OPTIONS`를 복사하여 `"timeout"` 키를 추가한 `_app_rtp_opts`를 `av.open()` 시점에 전달

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

  // 3. ONVIF 구조화 파싱 + 상태변화 dedup + DB 저장
  // parseOnvifPayload()는 패킷 내 모든 NotificationMessage를 배열로 반환
  if (_db && data.payload) {
    const parsedList = parseOnvifPayload(data.payload);  // ParsedOnvifEvent[] | null
    if (Array.isArray(parsedList)) {
      for (const parsed of parsedList) {
        // Radiometry: dedup 없이 즉시 브로드캐스트 (실시간 온도 오버레이용)
        if (parsed.radiometry?.length > 0 && _io)
          _io.emit('onvif:temperature', { cameraId, utcTime: parsed.utcTime, readings: parsed.radiometry });

        // 상태 변화 시에만 DB 저장 + 소켓 브로드캐스트
        // RuleName이 다른 이벤트는 별도 이벤트 스트림으로 처리 — dedup key에 포함
        const dedupKey = `${cameraId}:${parsed.topic}:${parsed.sourceToken}:${parsed.ruleName ?? ''}`;
        if (_lastStates.get(dedupKey) !== parsed.state) {
          _lastStates.set(dedupKey, parsed.state);
          const event = { id: uuidv4(), cameraId, ...parsed, serverTs: new Date().toISOString() };
          _db.insert('onvif_events', event);
          if (_io) _io.emit('onvif:event', event);
          // topicType 최초 등록 시 전역 레지스트리에 추가
          // state=true 또는 포인트 이벤트(state=null) 시 프레임 스냅샷 저장
        }
      }
    }
  }

  res.sendStatus(200);
});
```

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

## 8. ONVIF 구조화 파싱 — 구현 현황

`server/src/services/onvifParser.js`가 외부 의존성 없이 정규식 기반으로 ONVIF XML을 파싱합니다.

### 8.1 다중 NotificationMessage 파싱 (v1.4)

`parseOnvifPayload()` 는 `ParsedOnvifEvent[] | null` 을 반환합니다.
하나의 MetadataStream 패킷에 여러 `NotificationMessage` 블록이 담겨 오는 경우(Samsung 카메라 실제 관찰),
각 블록을 `parseSingleNotification()` 으로 개별 파싱하여 배열로 반환합니다.

```javascript
// onvifParser.js 반환 구조
function parseOnvifPayload(base64Payload) {
  const xml = Buffer.from(base64Payload, 'base64').toString('utf-8');
  if (!xml.includes('MetadataStream')) return null;
  const notifRe = /<(?:[^:>\s]+:)?NotificationMessage>([\s\S]*?)<\/(?:[^:>\s]+:)?NotificationMessage>/g;
  const results = [];
  let m;
  while ((m = notifRe.exec(xml)) !== null) {
    const parsed = parseSingleNotification(m[1]);
    if (parsed) results.push(parsed);
  }
  return results.length > 0 ? results : null;  // fallback: whole XML as single block
}
```

`internalApi.js`는 반환된 배열을 순회하여 각 이벤트를 독립적으로 dedup·저장·브로드캐스트합니다.

### 8.2 RuleName 기반 이벤트 분리 (v1.7)

ONVIF VideoAnalytics 이벤트에는 **다수의 분석 규칙(Rule)**이 단일 카메라에 정의될 수 있습니다. 예를 들어:

```xml
<!-- Rule: Zone1_Loitering -->
<tt:Source>
  <tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="VA-1"/>
  <tt:SimpleItem Name="RuleName" Value="Zone1_Loitering"/>
</tt:Source>

<!-- Rule: Zone2_Entry (같은 topicType, 다른 RuleName) -->
<tt:Source>
  <tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="VA-1"/>
  <tt:SimpleItem Name="RuleName" Value="Zone2_Entry"/>
</tt:Source>
```

`RuleName`이 다른 두 이벤트는 **동일한 카메라·토픽·소스 토큰**을 공유하더라도 **독립적인 이벤트 스트림**으로 처리해야 합니다. 이를 위해:

1. **`onvifParser.js`**: `items['RuleName'] ?? items['Rule'] ?? null` 추출 → `parsed.ruleName` 반환
2. **`internalApi.js`**: dedup key에 `ruleName` 포함  
   `${cameraId}:${topic}:${sourceToken}:${ruleName ?? ''}`  
   저장 이벤트 구조에도 `ruleName: parsed.ruleName ?? null` 추가
3. **`onvif_events` DB 레코드**: `ruleName` 필드 저장
4. **클라이언트 타임라인**: `OnvifTimelineInline.tsx` · `OnvifTimelineOverlay.tsx` 에서  
   `(topicType, sourceToken, ruleName)` 3-튜플을 행 키로 사용 → **RuleName별 독립 타임라인 행** 렌더링

### 8.3 향후 확장 — alertService 연동

현재 ONVIF 이벤트는 `onvif_events` DB에만 저장됩니다. 향후 `alertService.js` 연동 시:
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

#### 9.4.1 Area별 독립 Map 상태 관리

카메라는 Area(ItemID/AreaName)별로 **별도 이벤트**를 전송하는 경우가 많습니다. 단순히 최신 이벤트 전체로 상태를 교체하면 이전 Area가 사라지므로, `Map<areaKey, AreaSlot>`으로 Area마다 독립 관리합니다.

```ts
// Area 식별 키: itemId → areaName → "area-{idx}" 순서로 결정
function areaKey(r: ThermalReading, fallback: string): string {
  return r.itemId ?? r.areaName ?? fallback;
}

// 상태 구조
Map<string, { reading: ThermalReading; utcTime: string }>

// 이벤트 처리 — 각 reading을 개별 upsert (다른 Area 유지)
handler = (evt) => {
  setAreas(prev => {
    const next = new Map(prev);
    evt.readings.forEach((r, idx) => {
      const key = areaKey(r, `area-${idx}`);
      next.set(key, { reading: r, utcTime: evt.utcTime });
      // 기존 타이머 초기화 후 새 타이머 등록
      resetFadeTimer(key);
    });
    return next;
  });
};
```

각 Area는 **독립된 6초 fade 타이머**를 가지며, 특정 Area의 데이터가 6초간 수신되지 않으면 해당 Area만 제거됩니다 (다른 Area 유지).

#### 9.4.2 FullArea 판별

| 조건 | 표시 방식 |
|---|---|
| `AreaName="FullArea"` 또는 `ItemID="Z"` | **상단 배너** — crosshair 없음, 전체 프레임 온도 요약 |
| 그 외 특정 좌표 영역 | SVG **crosshair** (red=최고, sky-blue=최저) + 좌하단 정보 패널 |

두 유형이 동시에 존재하면 모두 표시됩니다. 복수의 FullArea 배너도 나란히 표시됩니다.

#### 9.4.3 좌표 매핑

카메라 픽셀 좌표 → 화면 좌표는 `getRenderArea()` 레터박스 보정 알고리즘을 사용합니다 (CameraView detection overlay와 동일):

```ts
function toScreen(px, py, fw, fh, cw, ch) {
  const { rw, rh, ox, oy } = getRenderArea(fw, fh, cw, ch);
  return { sx: ox + (px / fw) * rw, sy: oy + (py / fh) * rh };
}
```

crosshair 라벨은 `"AreaName 79.4°C"` 형식으로 Area 이름을 포함하여 복수 Area 구분이 가능합니다.

#### 9.4.4 온도 단위 heuristic

| 값 범위 | 해석 | 표시 형식 |
|---|---|---|
| > 200 | Kelvin (FLIR 계열) | `352.5 (79.4°C)` |
| ≤ 200 | Celsius | `79.4°C` |

#### 9.4.5 Fade 타이머

`FADE_MS = 6000` — Area별 독립 타이머. `timersRef: Map<areaKey, timer>`로 관리하며 Area별로 마지막 수신 후 6초가 지나야 해당 Area만 제거됩니다.

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
| 1.3 | 2026-06-23 | §9.4 ThermalOverlay Area별 독립 Map 상태 관리로 전환 — 카메라가 Area별 별도 이벤트 전송 시 전체 교체 대신 upsert, Area별 독립 fade 타이머, crosshair 라벨에 AreaName 접두사 추가 |
| 1.4 | 2026-06-23 | §3 패킷 특성 업데이트, §2.2 토픽 표 Samsung 변형 추가 (DigitalInput·MotionDetection·AudioDetection·RadiometryAlarm·TemperatureAlarm·TemperatureDifference·Relay), §6 internalApi 코드 배열 처리 반영, §8 향후 계획 → 구현 현황으로 개정 (다중 NotificationMessage 파싱) |
| 1.5 | 2026-06-23 | §5.3 `_app_rtp_ingest_once` 코드 스니펫 업데이트 — `inp.read_timeout` 속성 쓰기 방식을 `av.open(options={"timeout":…})` 방식으로 교체; §5.4 PyAV 버전 호환성 섹션 추가 및 버그 이력 기술 |
| 1.6 | 2026-06-24 | §5.5 추가 — MediaMTX 환경 App RTP URL 분리: `appRtpRtspUrl`로 AI 경로(MediaMTX)와 ONVIF 수집 경로(원본 카메라) 분리; EADDRINUSE 3회 → 스레드 조용히 종료 방어 처리 |
| 1.7 | 2026-06-24 | §8.2 추가 — RuleName 기반 이벤트 분리: `parsed.ruleName` 추출, dedup key에 포함, DB 저장, 타임라인 행 분리 |
