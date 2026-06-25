# RTSP → WebRTC 실시간 AI 스트리밍 아키텍처 설계서

**Version:** 1.7  
**대상:** 언어·런타임에 독립적인 구현 가이드 (Node.js / Go / Python / Rust / C++ / Java)

---

## 0. 수집 레이어 불변 원칙 (Architecture Invariants)

> **이 원칙은 LTS-2026의 핵심 설계 결정입니다. 구현 선택 시 항상 이 원칙을 최우선으로 합니다.**

### 0.1 ingest-daemon 우선 원칙

**RTSP로 연결 가능한 모든 카메라 스트림은 `ingest-daemon`(Python PyAV)을 유일한 수집 계층으로 사용한다.**

| 소스 유형 | 수집 수단 | FFmpeg 사용 여부 |
|---|---|---|
| RTSP / ONVIF IP 카메라 | **ingest-daemon 전용** | ❌ 금지 |
| YouTube / RTMP / HLS | yt-dlp → ffmpeg → MediaMTX | ✅ 불가피한 경우만 허용 |

### 0.2 ingest-daemon 팬아웃 설계

ingest-daemon은 **카메라 RTSP URL에 직접 단일 PyAV 세션을 열고** 아래 경로를 동시에 공급한다.  
어느 WebRTC 엔진을 선택해도 수집 레이어는 ingest-daemon으로 고정된다.

#### WEBRTC_ENGINE=mediasoup (현재 기본 설정)

```
IP 카메라 RTSP (직접 연결)
    │
    └── ingest_daemon.py (PyAV 단일 세션)
            ├── ① JPEG        → HTTP POST → /api/internal/frame/:id      (항상 활성)
            │                   → AI pipeline (YOLO/ByteTrack)
            │
            ├── ② H.264 RTP  → UDP:{mediasoupPort}
            │                   → mediasoup PlainTransport → 비디오 Producer → 브라우저 <video>
            │
            ├── ③ Opus RTP   → UDP:{mediasoupAudioPort}
            │                   → mediasoup PlainTransport → 오디오 Producer → 브라우저 <audio>
            │
            └── ④ App RTP    → HTTP POST → /api/internal/apprtp/:id      (ONVIF 메타데이터)
                                → Node.js → onvif_events DB + Socket.IO emit('onvif:event')
```

> **MediaMTX 불필요**: ingest-daemon이 단일 PyAV 세션에서 ①②③④를 모두 팬아웃하므로
> 카메라 RTSP 연결은 1개(주 스트림) + 1개(App RTP 전용 세션)만 사용한다.
> MediaMTX relay를 거치면 연결이 오히려 3개(MediaMTX→카메라, 데몬→MediaMTX, 데몬→카메라 AppRTP)로 늘어난다.

#### WEBRTC_ENGINE=mediamtx

```
IP 카메라 RTSP
    │
    └── MediaMTX(:8554) ── WHEP → 브라우저 <video>/<audio>
            │
            └── ingest_daemon.py (MediaMTX RTSP loopback 읽기)
                    ├── ① JPEG   → HTTP POST → /api/internal/frame/:id
                    └── ④ App RTP (직접 카메라 URL) → /api/internal/apprtp/:id
```

### 0.3 WEBRTC_ENGINE별 데이터 전달 경로

| 트랙 | mediamtx 모드 | mediasoup 모드 |
|---|---|---|
| 비디오 (H.264) | MediaMTX WHEP → SRTP | mediasoup WebRtcTransport → SRTP |
| 오디오 (Opus) | MediaMTX WHEP → SRTP | mediasoup WebRtcTransport → SRTP |
| Application RTP (PT 96~127) | Socket.IO `appRtp` 이벤트 | WebRTC DataChannel (SCTP) |

> **mediamtx 모드**: MediaMTX가 WHEP으로 비디오/오디오를 직접 브라우저에 전달. App RTP는 ingest-daemon이 HTTP POST → Socket.IO 경유.  
> **mediasoup 모드**: ingest-daemon이 RTP를 mediasoup PlainTransport로 공급. App RTP는 DirectTransport DataProducer → DataConsumer → DataChannel 경유.

### 0.3 금지 사항

- **RTSP 수집에 FFmpeg subprocess를 직접 사용하지 않는다.**
  - `rtspCapture.js`, `gstreamerCapture.js`, `pyavCapture.js`는 레거시이며 신규 카메라에 사용 금지.
  - `mediasoupEngine.js`가 WebRTC용 RTP가 필요할 때도 FFmpeg을 직접 spawn하지 않는다.
    → ingest-daemon `POST /cameras { mediasoupPort, mediasoupAudioPort }` API로 요청.
- **MediaMTX WHEP은 영상/음성만 브라우저로 전달하며 DataChannel을 지원하지 않는다.**
  → DataChannel(AI 검출 결과 전송)이 필요하면 `WEBRTC_ENGINE=mediasoup`으로 전환해야 한다.

---

## 1. 시스템 전체 구조

### 1.1 계층 다이어그램

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          IP 카메라 / 소스                                 │
│   RTSP (H.264/H.265/MJPEG)   │   ONVIF   │   YouTube HLS/DASH           │
└───────────────────┬─────────────────────────────────────────────────────┘
                    │ RTSP pull — 카메라당 단 1개 연결
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│          인제스트 프로세서 (단일 프로세스 · 내부 멀티스레드)                   │
│                                                                         │
│  [수신 스레드]  RTSP demux / RTP 수신                                     │
│      │                                                                  │
│      │  내부 패킷 큐 / tee (thread-safe)                                  │
│      │                                                                  │
│      ├──► [AI 소비자 스레드]    JPEG 디코드 → 프레임 버퍼                   │
│      ├──► [WebRTC 소비자 스레드] RTP 패킷 → SFU PlainTransport / WHEP     │
│      └──► [녹화 스레드]         세그먼트 mux → Object Storage              │
│                                                                         │
│  구현 선택:                                                               │
│  A. GStreamer pipeline (tee 엘리먼트 — 단일 파이프라인)                    │
│  B. MediaMTX relay (Go 프로세스 — 내부 고루틴 팬아웃 + RTSP loopback)      │
│  C. libav C API (libavformat/libavcodec — 인프로세스 라이브러리)            │
│  D. gortsplib + 고루틴 채널 팬아웃 (Go 자체 구현)                          │
└──────┬───────────────────────────┬──────────────────────────────────────┘
       │ 프레임/픽셀 버퍼             │ RTP 패킷 (loopback UDP 또는 IPC)
       ▼                            ▼
┌──────────────────────┐   ┌──────────────────────────────────────────────┐
│   AI 파이프라인        │   │        WebRTC SFU / 엔진                     │
│                      │   │                                              │
│ Detection            │   │ ① MediaMTX WHEP (외부 프로세스)               │
│ YOLO ONNX/TRT        │   │   RTSP → WebRTC (H.264 → SRTP)              │
│                      │   │                                              │
│ Tracking             │   │ ② mediasoup SFU (내장 Node.js)               │
│ ByteTrack / SORT     │   │   PlainTransport ← RTP (loopback)            │
│                      │   │   WebRtcTransport → 브라우저                  │
│ Behavior Engine      │   │                                              │
│ Zone / Loitering     │   │ ③ Janus Gateway (C, 독립 프로세스)            │
│                      │   │   videoroom / streaming plugin               │
│ Attribute (선택)      │   │                                              │
│ Face Re-ID / PPE     │   │ ④ self-built SFU (Go/Rust/C++)               │
│                      │   │   pion/webrtc, webrtc-rs, libwebrtc          │
└──────────┬───────────┘   └──────────────────┬───────────────────────────┘
           │ 검출 결과 (JSON)                   │ SRTP / ICE (UDP)
           ▼                                   ▼
┌──────────────────────────┐   ┌────────────────────────────────────────┐
│      AI 파이프라인          │   │     브라우저 / 클라이언트 (WebRTC)        │
│                          │   │                                        │
│ ① Detection              │   │ RTCPeerConnection                      │
│   YOLO (ONNX/TRT/Core ML)│   │ addTransceiver('video', {recvonly})    │
│                          │   │                                        │
│ ② Tracking               │   │ WHEP signaling (SDP offer/answer)      │
│   ByteTrack / SORT / OC  │   │ POST /api/webrtc/whep/:cameraId        │
│                          │   │                                        │
│ ③ Behavior               │   │ ICE → DTLS → SRTP 수신                 │
│   Zone / Loitering       │   │ <video> 렌더링                          │
│                          │   │                                        │
│ ④ Attribute (선택)        │   └────────────────────────────────────────┘
│   Face Re-ID / PPE / 의류 │
└──────────┬───────────────┘
           │ 검출 결과 (JSON)
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        이벤트·결과 처리                                    │
│                                                                         │
│  시그널링 서버 (REST + WebSocket/Socket.IO)                               │
│  ├─ /api/webrtc/whep/:id   WHEP SDP 중계                                │
│  ├─ /api/cameras           카메라 CRUD                                   │
│  ├─ /api/alerts            이벤트 알림                                    │
│  ├─ WS: frame              JPEG 스트림 (WebRTC 불가 폴백)                  │
│  ├─ WS: detections         실시간 검출 결과                                │
│  └─ WS: alert:new          배회/화재 알림                                  │
└──────────┬──────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          저장 레이어                                       │
│  ① 영상 세그먼트 (MP4 / fMP4 / TS)  →  Object Storage (S3/MinIO/로컬)    │
│  ② 메타데이터·이벤트               →  DB (JSON / MongoDB / PostgreSQL)    │
│  ③ 스냅샷 (JPEG 크롭)              →  파일시스템 / Object Storage         │
│  ④ 얼굴 임베딩                     →  벡터 DB (Qdrant / pgvector / 파일)  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 핵심 데이터 흐름 상세

### 2.1 라이브 스트리밍 경로 (Live Path)

> **핵심 원칙**: RTSP 소스 연결은 카메라당 **반드시 1개**. 인제스트 프로세서가 내부 멀티스레드로 AI·WebRTC·녹화 경로를 동시에 공급한다.

```
카메라 RTSP
  │
  │ ① 단일 RTSP 연결 (인제스트 프로세서 → 카메라, 1개만 유지)
  ▼
┌────────────────────────────────────────────────────────────┐
│  인제스트 프로세서 (단일 프로세스 · 멀티스레드)                 │
│                                                            │
│  [수신 스레드] RTSP demux / H264 RTP 수신                   │
│        │                                                   │
│        │ ② 내부 tee / 패킷 큐 (thread-safe)                 │
│        │                                                   │
│   ┌────┴──────┬──────────────┐                            │
│   ▼           ▼              ▼                            │
│ [AI 스레드]  [WebRTC 스레드]  [녹화 스레드]                  │
│ JPEG 디코드  RTP 패킷 포워딩  세그먼트 mux                    │
└────┬──────────┴──────────────┴───────────────────────────┘
     │              │
     │              │ ③ RTP over UDP (loopback / IPC)
     │              ▼
     │      PlainTransport (SFU 내부)
     │              │
     │              ▼
     │      Producer (H264, PT=96, SSRC=고정)
     │              │
     │              │ ④ WHEP 협상 (POST SDP offer → SDP answer 201)
     │              ▼
     │      WebRtcTransport / PeerConnection
     │              │
     │              │ ⑤ ICE binding → DTLS handshake → SRTP 키 교환
     │              ▼
     │      브라우저 RTCPeerConnection → <video> 재생
     │
     │ JPEG / 픽셀 버퍼
     ▼
  AI 파이프라인 (YOLO → ByteTrack → BehaviorEngine)
     │
     ▼
  WebSocket broadcast (detections, alerts)
```

### 2.2 단일 인제스트 프로세서 — 구현 패턴 비교

카메라 → 인제스트 연결은 반드시 1개여야 합니다. 그 안에서 복수 소비자로 팬아웃하는 방법은 아래 4가지입니다.

#### 패턴 A: GStreamer tee (순수 단일 파이프라인)

```
rtspsrc location=rtsp://camera/stream
  ! queue
  ! tee name=t

t. ! queue ! jpegenc quality=85
   ! appsink name=ai_sink emit-signals=true   ← AI 스레드 (콜백)

t. ! queue ! rtph264pay config-interval=1 pt=96
   ! udpsink host=127.0.0.1 port=5004         ← SFU PlainTransport

t. ! queue ! h264parse
   ! splitmuxsink location=seg_%05d.mp4 max-size-time=30000000000  ← 녹화 스레드
```

- **특징**: OS 수준에서 1개 프로세스, GStreamer 내부에서 3개 GstTask(스레드) 운용
- **연결 수**: 카메라에 정확히 1개 RTSP TCP 소켓
- **단점**: GStreamer 의존성, 파이프라인 오류 시 전체 재시작

#### 패턴 B: MediaMTX relay (현재 구현, 권장)

```
카메라 ──RTSP(1)──► MediaMTX (단일 프로세스 · Go 고루틴 팬아웃)
                         │
                  ├── RTSP loopback :8554/{id}
                  │        ├── [AI 소비자] GStreamer rtspsrc → appsink / PyAV / gortsplib
                  │        └── [SFU 소비자] GStreamer rtspsrc → udpsink(RTP) / gortsplib
                  ├── WHEP  :8889/{id}   ← 브라우저 직접
                  └── HLS   :8888/{id}   ← 녹화/VOD (MediaMTX 내장)
```

- **특징**: MediaMTX가 단일 RTSP 연결을 보유하고, 하위 소비자는 loopback RTSP로 접속
- **연결 수**: 카메라에 1개 + loopback에 N개 (카메라 부하 없음)
- **소비자 구현**: GStreamer / PyAV / gortsplib 등 인프로세스 라이브러리 사용 — subprocess 금지
- **단점**: loopback RTSP 소켓 추가 (성능 영향은 무시할 수준)

#### 패턴 C: libav C API (인프로세스 복수 출력)

```c
// 단일 AVFormatContext → 내부 스레드 큐로 팬아웃
AVFormatContext *fmt_ctx;
avformat_open_input(&fmt_ctx, rtsp_url, NULL, NULL);

// 수신 루프 (별도 스레드)
while (av_read_frame(fmt_ctx, &pkt) >= 0) {
    AVPacket *ai_pkt    = av_packet_clone(&pkt); // AI 큐로 push
    AVPacket *sfu_pkt   = av_packet_clone(&pkt); // SFU 큐로 push
    AVPacket *rec_pkt   = av_packet_clone(&pkt); // 녹화 큐로 push
    av_packet_unref(&pkt);
    // 각 큐는 독립 소비자 스레드가 처리
}
```

- **특징**: libavformat/libavcodec 인프로세스 라이브러리, OS 프로세스 추가 없음
- **연결 수**: 카메라에 정확히 1개 RTSP TCP 소켓
- **장점**: 최고 성능·메모리 제어, C/C++/Rust(rsmpeg crate)/Java(JavaCV) 사용 가능

#### 패턴 D: 언어 네이티브 (Go 예시)

```go
// 1개 RTSP 클라이언트 → 내부 채널 팬아웃
type IngestProcessor struct {
    aiCh      chan *rtp.Packet  // AI 소비자 고루틴
    webrtcCh  chan *rtp.Packet  // WebRTC SFU 고루틴
    recordCh  chan *rtp.Packet  // 녹화 고루틴
}

func (p *IngestProcessor) Run(rtspURL string) {
    client := &gortsplib.Client{}
    client.OnPacketRTPAny(func(ctx *gortsplib.ClientOnPacketRTPCtx) {
        pkt := ctx.Packet.Clone()
        // 비차단 전송 — 슬로우 소비자가 빠른 소비자를 블록하지 않음
        select { case p.aiCh <- pkt: default: }
        select { case p.webrtcCh <- pkt.Clone(): default: }
        select { case p.recordCh <- pkt.Clone(): default: }
    })
    client.StartRecording(rtspURL, ...)
}
```

- **특징**: 순수 언어 레벨 팬아웃, 소비자별 독립 고루틴
- **연결 수**: 카메라에 정확히 1개 RTSP 연결
- **장점**: 의존성 최소, 세밀한 역압(backpressure) 제어

---

### 2.3 WHEP 시그널링 상세

```
브라우저                        시그널링 서버                  SFU
   │                                 │                         │
   │  POST /api/webrtc/whep/:id      │                         │
   │  Content-Type: application/sdp  │                         │
   │  Body: SDP offer (recvonly)     │                         │
   │─────────────────────────────────►                         │
   │                                 │  createWebRtcTransport  │
   │                                 │─────────────────────────►
   │                                 │                         │
   │                                 │  transport.connect()    │
   │                                 │  (DTLS fingerprint)     │
   │                                 │─────────────────────────►
   │                                 │                         │
   │                                 │  transport.consume()    │
   │                                 │  (producerId, rtpCaps)  │
   │                                 │─────────────────────────►
   │                                 │                         │
   │                                 │  SDP answer 생성         │
   │                                 │◄─────────────────────────
   │                                 │                         │
   │  HTTP 201 Created               │                         │
   │  Content-Type: application/sdp  │                         │
   │  Body: SDP answer (sendonly)    │                         │
   │◄────────────────────────────────                          │
   │                                 │                         │
   │  setRemoteDescription(answer)   │                         │
   │  ICE binding requests ──────────────────────────────────► │
   │  DTLS ClientHello ──────────────────────────────────────► │
   │  SRTP media flow ◄───────────────────────────────────────  │
```

---

## 3. 컴포넌트별 기술 선택 매트릭스

### 3.1 RTSP 캡처 백엔드

> **원칙**: 인제스트 백엔드는 반드시 **인프로세스(in-process) 라이브러리**여야 합니다.  
> `ffmpeg` 또는 `gst-launch` 를 **subprocess(자식 프로세스)**로 실행하는 방식은 카메라당 별도 OS 프로세스를 생성하므로 **금지**입니다.

| 백엔드 | 언어/런타임 | 라이브러리 | 장점 | 단점 |
|---|---|---|---|---|
| **libav C API** | C / C++ / Rust (rsmpeg) / Java (JavaCV) | libavformat, libavcodec | 최고 성능, 메모리 제어, 코덱 최광범위 | API가 복잡 |
| **GStreamer appsink** | C / Python (gst-python) / Rust (gstreamer-rs) / Java | 네이티브 GStreamer | tee로 내부 팬아웃, 하드웨어 디코딩(nvdec/vaapi) | 의존성 복잡 |
| **PyAV** | Python | `av` (libav Python 바인딩) | NumPy·CUDA 연동, in-process | Python GIL 제약 |
| **gortsplib** | Go | bluenviron/gortsplib | 고루틴 기반, 경량, 팬아웃 채널 구현 용이 | H264 디코딩 직접 구현 필요 |
| **aiortc** | Python | aiortc (libav 내장) | asyncio + WebRTC 통합 | asyncio 단일 루프 병목 |
| **retina** | Rust | retina (tokio 기반) | 비동기, 안전한 소유권 | 코덱 처리 직접 구현 |
| **LIVE555** | C++ | live555 (정적 링크) | 임베디드 환경 | 구형 API |

**권장**:
- **C++ 서버**: `libav C API` — 인프로세스, 최고 성능
- **Python 서버**: `GStreamer appsink` (GPU) 또는 `PyAV` (간단한 경우)
- **Go 서버**: `gortsplib` + 고루틴 채널 팬아웃
- **릴레이 기반**: `MediaMTX` + loopback RTSP → 각 소비자는 위 라이브러리로 연결

---

### 3.2 미디어 릴레이 (RTSP → WebRTC 브리지)

#### 옵션 A: MediaMTX (현재 구현, 권장)

```
[카메라 RTSP] ──pull(1개)──► [MediaMTX]
                                   │ 내부 Go 고루틴 팬아웃
                    ├── RTSP re-pub  :8554/{id}  ← AI / SFU 인프로세스 라이브러리 소비
                    ├── WHEP         :8889/{id}  ← 브라우저 직접 연결
                    ├── HLS          :8888/{id}  ← 녹화/VOD (내장)
                    └── REST API     :9997        ← 경로 동적 등록
```

- **언어**: Go (바이너리 단독 실행)
- **장점**: 단일 카메라 연결, 다수 소비자 분배, WHEP 내장
- **설정**: `mediamtx.yml` — `api: yes`, `pathDefaults.maxReaders: N`

#### 옵션 B: Janus Gateway (C, 독립 프로세스)

```
[카메라 RTSP] ──GStreamer rtspsrc──► [udpsink RTP → Janus streaming plugin]
                                                │
                                    WebRTC PeerConnection per viewer
```

- **장점**: 플러그인 아키텍처, 내장 레코딩, Admin API
- **단점**: 복잡한 설정, WHEP 미내장 (커스텀 시그널링 필요)

#### 옵션 C: 자체 릴레이 (Go / Rust)

```go
// Go + pion/webrtc + gortsplib 예시
rtspClient := gortsplib.Client{}
rtspClient.OnPacketRTP(func(ctx *gortsplib.ClientOnPacketRTPCtx) {
    // RTP 패킷 → mediasoup PlainTransport 또는 pion PeerConnection으로 전달
    sfuBridge.Write(ctx.Packet.Marshal())
})
```

- **라이브러리**: `bluenviron/gortsplib` (Go), `rtsp-rs` (Rust), `live555` (C++)

---

### 3.3 WebRTC SFU (Selective Forwarding Unit)

#### SFU 동작 원리

```
                    ┌─────────────────────────────────────────┐
                    │              SFU 내부                    │
                    │                                         │
 인제스트 RTP ─────► │ PlainTransport → Producer               │
 (loopback UDP)     │  GStreamer udpsink / gortsplib / libav  │
                    │         ▼                               │
                    │    Router (패킷 라우팅)                   │
                    │         │                               │
                    │    ┌────┴─────┐                         │
                    │    ▼          ▼                         │
                    │ Consumer1  Consumer2  ...               │
                    │    │          │                         │
                    │ WebRtcT-1  WebRtcT-2                    │
                    └────┼──────────┼──────────────────────────┘
                         │          │
                    SRTP over UDP   SRTP over UDP
                         ▼          ▼
                    Browser1    Browser2
```

| SFU | 언어 | 특징 | WHEP | 패키지 |
|---|---|---|---|---|
| **mediasoup** | Node.js (C++ Worker) | 고성능, 낮은 지연, 정밀한 제어 | 수동 구현 | `mediasoup` npm |
| **Janus** | C (플러그인) | 범용, 레코딩 내장 | 플러그인 필요 | 독립 프로세스 |
| **ion-sfu** | Go | 클라우드 네이티브, gRPC | 내장 | `pion/webrtc` |
| **mediasoup-go** | Go | mediasoup 포트 | 수동 구현 | github |
| **str0m** | Rust | 순수 Rust, 비동기 | 수동 구현 | crates.io |
| **pion/webrtc** | Go | 저수준 WebRTC 빌딩블록 | 수동 구현 | `pion/webrtc` |
| **aiortc** | Python | asyncio 기반 | 수동 구현 | PyPI |
| **Kurento** | Java/C++ | Spring Boot 연동, 미디어 파이프라인 | 플러그인 | Maven |
| **werift** | TypeScript | 순수 TS, 브라우저 유사 API | 수동 구현 | npm |

---

### 3.4 SDP 협상 (WHEP 구현 핵심)

#### 브라우저 SDP offer (recvonly) 파싱 필요 항목

```
v=0
o=- 12345 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1               ← BUNDLE 그룹 (mid 목록)
m=video 9 UDP/TLS/RTP/SAVPF 96
a=ice-ufrag:xxxx                  ← ICE username fragment
a=ice-pwd:yyyyyyy                 ← ICE password
a=fingerprint:sha-256 AA:BB:...  ← DTLS fingerprint (필수 파싱)
a=setup:actpass                   ← 브라우저 role (서버는 passive로 응답)
a=mid:0                           ← mid 값 파싱
a=recvonly                        ← 브라우저는 수신 전용
a=rtpmap:96 H264/90000
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=mid:1
```

#### 서버 SDP answer (sendonly) 생성 필수 항목

```
v=0
o=sfu 10000 10000 IN IP4 {SERVER_IP}
s=-
t=0 0
a=group:BUNDLE {video_mid} {audio_mid}
a=extmap-allow-mixed
m=video 7 UDP/TLS/RTP/SAVPF {pt} {rtx_pt}
c=IN IP4 {ANNOUNCED_IP}
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:{transport.iceParameters.usernameFragment}
a=ice-pwd:{transport.iceParameters.password}
a=ice-options:trickle
a=fingerprint:{algorithm} {value}   ← 서버 DTLS fingerprint
a=setup:passive                     ← 서버는 항상 passive
a=mid:{video_mid}
a=sendonly
a=rtcp-mux
a=rtcp-rsize
a=rtpmap:{pt} H264/90000
a=fmtp:{pt} packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1
a=rtpmap:{rtx_pt} rtx/90000
a=fmtp:{rtx_pt} apt={pt}
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=ssrc:{ssrc} cname:sfu
a=candidate:{foundation} 1 udp {priority} {ANNOUNCED_IP} {port} typ host
m=audio 9 UDP/TLS/RTP/SAVPF 111   ← 오디오 없으면 bundle-only + inactive
c=IN IP4 {ANNOUNCED_IP}
a=bundle-only
a=mid:{audio_mid}
a=inactive
a=rtpmap:111 opus/48000/2
```

---

### 3.5 AI 파이프라인 컴포넌트

```
JPEG 버퍼 (640×640)
      │
      ▼
┌─────────────────────────────────────────────────────┐
│                   객체 검출 (Detection)               │
│                                                     │
│  입력: JPEG → BGR/RGB uint8[H,W,3]                  │
│  전처리: resize → normalize → CHW → float32[1,3,640,640] │
│                                                     │
│  런타임 선택:                                         │
│  ① ONNX Runtime    모든 언어 (C/C++/Python/Java/C#) │
│  ② TensorRT        C++ / Python  (NVIDIA GPU)       │
│  ③ CoreML          Swift / ObjC  (Apple Silicon)    │
│  ④ TFLite          C / Python / Java  (모바일/엣지) │
│  ⑤ OpenVINO        C++ / Python  (Intel)            │
│                                                     │
│  출력: boxes[N,4] + scores[N] + class_ids[N]        │
│        NMS 후 → Detections[]                        │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│                     추적 (Tracking)                   │
│                                                     │
│  알고리즘 선택:                                       │
│  ① ByteTrack    Python/C++  이중임계 연관              │
│  ② SORT         Python/C++  Kalman + Hungarian       │
│  ③ OC-SORT      Python      Observation-Centric      │
│  ④ StrongSORT   Python      Re-ID 임베딩 결합         │
│  ⑤ BoT-SORT     Python      카메라 모션 보정           │
│                                                     │
│  핵심 자료구조:                                       │
│  Track { id, bbox, kalman_state, age, hits }        │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│                행동 분석 (Behavior Engine)             │
│                                                     │
│  다각형 Zone 관리                                     │
│  ① Point-in-Polygon 검사 (레이캐스팅 알고리즘)         │
│  ② 배회 타이머: 최초 진입 → 체류 시간 누적              │
│  ③ 이탈·재진입 윈도우 (REENTRY_WINDOW_SEC)            │
│  ④ 위험 점수 산출 (dwell time + 이동 여부 + zone type) │
│                                                     │
│  이벤트 발생 조건:                                    │
│  dwell_sec > LOITERING_THRESHOLD_SEC AND zone=MONITOR│
└─────────────────────────────────────────────────────┘
```

---

### 3.6 시그널링 서버 (REST + WebSocket)

```
클라이언트
    │
    │ HTTPS
    ▼
┌──────────────────────────────────────────────────────────┐
│                   시그널링 서버                             │
│                                                          │
│  REST API                                                │
│  ├─ POST /api/webrtc/whep/:id   WHEP SDP 교환            │
│  ├─ DELETE /api/webrtc/whep/:id  세션 종료                │
│  ├─ POST /api/webrtc/ice-test    ICE/엔진 상태 확인        │
│  ├─ GET  /api/cameras            카메라 목록               │
│  ├─ POST /api/cameras            카메라 등록               │
│  └─ GET  /health                 헬스체크                  │
│                                                          │
│  WebSocket / Socket.IO                                   │
│  ├─ frame       JPEG 스트림 (WebRTC 불가 폴백)             │
│  ├─ detections  실시간 AI 검출 결과                        │
│  ├─ alert:new   배회/화재/이상행동 알림                     │
│  ├─ camera:status 카메라 연결 상태 변경                    │
│  └─ face:reidentified  크로스카메라 동일인 전환             │
│                                                          │
│  구현 옵션:                                               │
│  ① Node.js    Express + Socket.IO (현재)                 │
│  ② Go         gin + gorilla/websocket                    │
│  ③ Python     FastAPI + websockets                       │
│  ④ Rust       actix-web + tokio-tungstenite              │
│  ⑤ Java       Spring WebFlux + WebSocket                 │
└──────────────────────────────────────────────────────────┘
```

---

### 3.7 Application RTP → WebRTC DataChannel 브리지

> **핵심 원칙**: RTP와 WebRTC DataChannel은 **서로 다른 프로토콜**이므로 직접 연결이 불가능합니다.  
> 카메라 RTSP 스트림 내 Application RTP(PT 96–127) 페이로드를 브라우저 DataChannel로 전달하려면 **SFU 중간에서 프로토콜 변환**이 필요합니다.

#### 3.7.1 프로토콜 계층 비교

| 경로 | 프로토콜 스택 | 용도 |
|---|---|---|
| 비디오 (H.264) | RTP → SRTP → WebRTC 미디어 트랙 | `<video>` 재생 |
| 오디오 (Opus) | RTP → SRTP → WebRTC 오디오 트랙 | `<audio>` 재생 |
| Application RTP (PT 96–127) | RTP 페이로드 추출 → **SCTP → DataChannel** | 임의 바이너리/JSON |
| AI 결과 (서버 생성) | 서버 직접 생성 → **SCTP → DataChannel** | 검출/추적 이벤트 |

> `DataChannel`은 SCTP over DTLS over UDP로 동작합니다. RTP 패킷 자체는 DataChannel로 흐르지 않으며, RTP 헤더를 제거한 **페이로드 바이트**만 SCTP 메시지로 재포장합니다.

#### 3.7.2 Application RTP → DataChannel 변환 경로

```
카메라 RTSP (Application RTP, PT=100 예시)
    │ ① RTSP demux — ingest-daemon / gortsplib / libav
    │   RTP 헤더 파싱: SSRC, timestamp, sequence, payload_type=100
    ▼
┌──────────────────────────────────────────────────────────────┐
│           SFU 내부 (mediasoup 예시)                            │
│                                                              │
│  PlainTransport (loopback UDP)                               │
│    │ ② RTP 수신 (PT=100, 미디어 아님)                         │
│    ▼                                                         │
│  DataProducer (SCTP)                                         │
│    │ ③ RTP 페이로드 바이트 추출                               │
│    │   (헤더 제거: 12 bytes + CSRC list)                      │
│    │   선택적으로 JSON 또는 MessagePack 래핑                   │
│    ▼                                                         │
│  Router → DataConsumer 1, 2, …                               │
└──────────────────────────────────────────────────────────────┘
    │ ④ SCTP over DTLS → 브라우저
    ▼
브라우저 RTCPeerConnection.ondatachannel
    datachannel.onmessage = (e) => {
        const payload = e.data;  // ArrayBuffer (바이너리)
        // 또는 JSON.parse(e.data) 로 파싱
    }
```

#### 3.7.3 DataChannel 메시지 스키마 (권장)

Application RTP 페이로드는 아래 포맷으로 래핑합니다:

```json
{
  "type": "app-rtp",
  "pt": 100,
  "ssrc": 1234567890,
  "timestamp": 90000,
  "seq": 42,
  "payload": "<base64 인코딩 또는 ArrayBuffer>"
}
```

AI 추론 결과 (서버 생성, RTP 아님):
```json
{
  "type": "detections",
  "cameraId": "cam-01",
  "frameId": 12345,
  "timestamp": 1718192000123,
  "objects": [
    { "id": 7, "class": "person", "bbox": [120, 80, 60, 180], "score": 0.92 }
  ]
}
```

경보 (신뢰성 전달 필요 → ordered reliable DataChannel):
```json
{
  "type": "loitering",
  "alertId": "uuid-v4",
  "cameraId": "cam-01",
  "dwellSec": 45.2,
  "riskScore": 0.78
}
```

#### 3.7.4 DataChannel 신뢰성 설정

| 메시지 유형 | 전달 모드 | 이유 |
|---|---|---|
| `detections` (프레임별 박스) | `maxRetransmits: 0` (비신뢰) | 최신 프레임이 중요; 유실 시 재전송 불필요 |
| `app-rtp` (Application RTP) | `maxRetransmits: 0` (비신뢰) | 실시간성 우선; 페이로드 종류에 따라 조정 |
| `loitering` / `fire` / `alert` | ordered reliable (기본값) | 경보 유실 불허 |
| `face:reidentified` | ordered reliable | Re-ID 이벤트 순서 보장 필요 |

```javascript
// 클라이언트 DataChannel 생성 예시 (mediasoup-client)
const unreliableDC = pc.createDataChannel('detections', { maxRetransmits: 0 });
const reliableDC   = pc.createDataChannel('alerts');  // 기본: ordered=true, reliable

// 서버 (mediasoup)
const dataProducer = await transport.produceData({
  label: 'detections',
  protocol: 'json',
  ordered: false,
  maxRetransmits: 0,
});
dataProducer.send(JSON.stringify(detectionMsg));
```

#### 3.7.5 Opus Audio vs Application RTP 경로 비교

```
카메라 RTSP
    │
    ├─ Video Track (H.264, PT=96)
    │      └─ SFU Producer → WebRtcTransport → SRTP → <video>
    │
    ├─ Audio Track (Opus, PT=111)
    │      └─ SFU Producer → WebRtcTransport → SRTP → <audio>
    │         ※ Opus 이외 코덱(AAC/G.711)은 FFmpeg/GStreamer로 Opus 트랜스코딩 후 전달
    │
    └─ Application Track (PT=100~127, 임의)
           └─ RTP 페이로드 추출 → DataProducer → SCTP → DataChannel
              ※ 이 경로는 mediasoup=mediasoup 환경에서만 지원
              ※ MediaMTX WHEP 환경: 별도 DataChannel 서버 엔드포인트 필요
```

#### 3.7.6 MediaMTX WHEP 환경에서의 한계

MediaMTX WHEP(`WEBRTC_ENGINE=mediamtx`)는 **미디어 트랙(H.264/Opus)만** 브라우저로 전달하며, **DataChannel을 지원하지 않습니다.**

| WebRTC 엔진 | DataChannel 지원 | Application RTP → DataChannel |
|---|---|---|
| **mediasoup** | ✅ DataProducer/Consumer | ✅ 가능 (구현 필요) |
| **MediaMTX WHEP** | ❌ 미지원 | ❌ 불가 (별도 WS 경로 필요) |
| **pion/webrtc** | ✅ (`CreateDataChannel`) | ✅ 가능 (직접 구현) |
| **aiortc** | ✅ (`RTCDataChannel`) | ✅ 가능 |

> **현재 LTS-2026**: `WEBRTC_ENGINE=mediamtx` 사용 중 → DataChannel 미지원.  
> AI 검출 결과는 Socket.IO (`frameData`, `newAlert`)로 전달. DataChannel 경로는 미구현(→ M4 Milestone).

---

## 4. 배포 모드 (SERVER_MODE)

### 4.1 combined 모드 (단일 서버)

```
┌─────────────────────────────────────────────────────┐
│                   단일 프로세스                       │
│                                                     │
│  MediaMTX ──────────────────────────────────────►  │
│  (외부 프로세스, loopback 통신)                       │
│                                                     │
│  캡처 백엔드 ──► AI 파이프라인 ──► WebSocket broadcast │
│       └──────────────────────────► SFU (WebRTC)    │
│                                                     │
│  REST API + WebSocket                               │
│  DB (JSON / MongoDB)                                │
└─────────────────────────────────────────────────────┘
```

- **적합**: 카메라 1~8대, 단일 GPU 서버
- **장점**: 관리 단순

---

### 4.2 streaming + analysis 분리 모드

```
┌─────────────────────────┐        ┌──────────────────────────┐
│   스트리밍 서버           │        │   분석 서버 (GPU)          │
│   (LAN IP: 192.168.x.y) │        │   (LAN IP: 192.168.x.z)  │
│                         │        │                          │
│  MediaMTX               │        │  ONNX Runtime / TensorRT │
│  캡처 백엔드              │        │  ByteTrack               │
│  WebRTC SFU              │        │  BehaviorEngine          │
│  REST API + WS           │        │  REST: /api/analysis/frame│
│                         │        │                          │
│  POST frame JPEG ───────────────► inference → detections    │
│                         │ HTTP   │                          │
│  ◄── detections JSON ───────────                            │
└─────────────────────────┘        └──────────────────────────┘
```

- **적합**: 카메라 서버(일반 CPU) + AI 서버(고성능 GPU) 분리
- **통신**: HTTP POST (circuit breaker 내장)

---

### 4.3 분산 클러스터 모드

```
                    ┌──────────────────────────────┐
                    │   로드 밸런서 / API Gateway    │
                    │   (nginx / Traefik / Envoy)   │
                    └───────────────┬──────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                       ▼
    ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
    │  스트리밍 노드 1   │  │  스트리밍 노드 2   │  │  스트리밍 노드 N   │
    │  카메라 그룹 A    │  │  카메라 그룹 B    │  │  카메라 그룹 C    │
    └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
             │                     │                      │
             └─────────────────────┼──────────────────────┘
                                   │  AMQP / Kafka
                                   ▼
                    ┌──────────────────────────────┐
                    │   분석 클러스터               │
                    │   GPU 노드 풀                 │
                    │   (Ray / Celery / 자체)       │
                    └──────────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │   공유 저장소                  │
                    │   S3/MinIO + MongoDB Atlas    │
                    └──────────────────────────────┘
```

---

## 5. 프로토콜 스택 상세

### 5.1 RTSP → WebRTC 변환 체인

```
[카메라] ──RTSP/TCP──► [릴레이] ──RTP/UDP(loopback)──► [SFU PlainTransport]
                                                              │
                                                    Producer (H.264, PT=96)
                                                              │
                                            [브라우저 WHEP 요청]
                                                              │
                                                    Consumer (remapped PT)
                                                              │
                                              WebRtcTransport (ICE/DTLS)
                                                              │
                                                         SRTP/UDP
                                                              │
                                                    [브라우저 video]
```

### 5.2 ICE/DTLS/SRTP 연결 순서

```
서버 측                          브라우저 측
   │                                  │
   │  ← STUN Binding Request ─────────│   (ICE 연결성 확인)
   │  → STUN Binding Response ────────│
   │                                  │
   │  ← DTLS ClientHello ─────────────│   (DTLS 1.3 핸드셰이크)
   │  → DTLS ServerHello + Cert ──────│
   │  ← DTLS Certificate + Verify ───│
   │  → DTLS Finished ────────────────│
   │                                  │
   │  ← DTLS Application (SRTP keys)  │   (SRTP 키 교환)
   │                                  │
   │  → SRTP RTP packets ─────────────│   (H.264 미디어 전송)
   │  ← RTCP (NACK/PLI/REMB) ─────────│   (품질 피드백)
```

### 5.3 포트 요구사항

| 서비스 | 포트 | 프로토콜 | 방향 | 설명 |
|---|---|---|---|---|
| HTTP | 3080 | TCP | 인바운드 | REST API |
| HTTPS | 3443 | TCP | 인바운드 | REST API (TLS) |
| MediaMTX RTSP | 8554 | TCP | loopback | RTSP re-publish |
| MediaMTX WHEP | 8889 | TCP | loopback | WebRTC 시그널링 |
| MediaMTX ICE | 8189 | UDP | **인바운드** | 브라우저 ICE 미디어 |
| MediaMTX API | 9997 | TCP | loopback | 경로 등록 REST |
| mediasoup ICE | 40000–49999 | UDP | **인바운드** | 브라우저 ICE 미디어 |
| STUN/TURN | 3478 | UDP+TCP | 인바운드 | ICE 보조 |

> **방화벽 필수**: 브라우저에서 서버로 도달하는 UDP 포트 (ICE 미디어) 개방 필요

---

## 6. 언어별 구현 가이드

### 6.1 Go — 권장 스택

```go
// 핵심 라이브러리
import (
    "github.com/bluenviron/gortsplib/v4"   // RTSP 클라이언트
    "github.com/pion/webrtc/v4"             // WebRTC (ICE/DTLS/SRTP)
    "github.com/pion/mediadevices"          // 미디어 트랙
    "github.com/gin-gonic/gin"              // REST API
    "github.com/gorilla/websocket"          // WebSocket
    "github.com/onnx/onnxruntime-go"        // ONNX 추론
)

// WebRTC SFU 핵심 흐름
type SFU struct {
    api       *webrtc.API
    producers map[string]*Producer // cameraId → Producer
}

type Producer struct {
    rtpSender  *RTPForwarder        // loopback RTP 수신
    videoTrack *webrtc.TrackLocalStaticRTP
}

// WHEP 핸들러
func (s *SFU) HandleWHEP(cameraId, sdpOffer string) (string, error) {
    pc, _ := s.api.NewPeerConnection(webrtc.Configuration{})
    videoTrack := s.producers[cameraId].videoTrack
    pc.AddTrack(videoTrack)
    pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdpOffer})
    answer, _ := pc.CreateAnswer(nil)
    pc.SetLocalDescription(answer)
    <-webrtc.GatheringCompletePromise(pc)
    return pc.LocalDescription().SDP, nil
}
```

**파이프라인 구성 예시 (Go):**

```
gortsplib.Client                 pion/webrtc
      │                               │
      │  OnPacketRTPAny               │
      ├─ H264 NAL units ──────────────► TrackLocalStaticRTP.Write(rtp)
      │                               │
      │  OnPacketRTPAny               │  CreatePeerConnection
      └─ Audio PCM ───────────────────► TrackLocalStaticRTP.Write(rtp)

ONNX 추론 (별도 goroutine):
      gortsplib → H264 패킷 → H264 디코더 (go-h264dec) → YUV → ResizeToTensor → onnxruntime-go
```

---

### 6.2 Python — 권장 스택

```python
# 핵심 라이브러리
# pip install aiortc av fastapi websockets onnxruntime-gpu ultralytics

from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.contrib.media import MediaPlayer
import av
import onnxruntime as ort
from fastapi import FastAPI, WebSocket
import asyncio

# RTSP → WebRTC SFU (aiortc)
class RTSPVideoTrack(VideoStreamTrack):
    def __init__(self, rtsp_url: str):
        super().__init__()
        self.container = av.open(rtsp_url, options={"rtsp_transport": "tcp"})
        self.stream = self.container.streams.video[0]

    async def recv(self):
        frame = next(self.container.decode(self.stream))
        pts, time_base = await self.next_timestamp()
        frame.pts = pts
        frame.time_base = time_base
        return frame

# WHEP 엔드포인트 (FastAPI)
app = FastAPI()
pcs: dict[str, RTCPeerConnection] = {}

@app.post("/api/webrtc/whep/{camera_id}")
async def whep(camera_id: str, body: bytes):
    pc = RTCPeerConnection()
    pcs[camera_id] = pc
    track = RTSPVideoTrack(f"rtsp://127.0.0.1:8554/{camera_id}")
    pc.addTrack(track)
    await pc.setRemoteDescription(RTCSessionDescription(sdp=body.decode(), type="offer"))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return Response(content=pc.localDescription.sdp, media_type="application/sdp", status_code=201)

# ONNX 추론 (별도 스레드)
sess = ort.InferenceSession("yolov8n.onnx", providers=["CUDAExecutionProvider"])
```

---

### 6.3 Rust — 권장 스택

```toml
# Cargo.toml
[dependencies]
str0m = "0.5"           # WebRTC (순수 Rust, 비동기)
retina = "0.4"          # RTSP 클라이언트
axum = "0.7"            # REST API (tokio 기반)
tokio = { version = "1", features = ["full"] }
ort = "2.0"             # ONNX Runtime 바인딩
image = "0.25"          # 이미지 처리
```

```rust
use str0m::{Rtc, Input, Output, Event};
use retina::client::Session;

// RTSP 수신 → WebRTC 전달
async fn rtsp_to_webrtc(rtsp_url: &str, rtc: &mut Rtc) {
    let mut session = Session::describe(rtsp_url.parse().unwrap(), SessionOptions::default())
        .await.unwrap();
    session.setup_all(SetupOptions::default()).await.unwrap();
    let playing = session.play(PlayOptions::default()).await.unwrap();

    while let Some(item) = playing.pkts().next().await {
        if let Ok(pkt) = item {
            // RTP 패킷을 WebRTC로 포워딩
            let rtp = RtpPacket::parse(&pkt.data()).unwrap();
            rtc.handle_input(Input::Receive(Instant::now(), rtp.into())).unwrap();
        }
    }
}

// WHEP 핸들러 (axum)
async fn handle_whep(
    Path(camera_id): Path<String>,
    body: String,
) -> impl IntoResponse {
    let mut rtc = Rtc::new();
    let offer = SdpOffer::from_sdp_string(&body).unwrap();
    let answer = rtc.accept_offer(offer).unwrap();
    (StatusCode::CREATED, answer.to_sdp_string())
}
```

---

### 6.4 C++ — 권장 스택

```cmake
# CMakeLists.txt 핵심 의존성
find_package(libav REQUIRED)          # libav 인프로세스 라이브러리 (libavformat, libavcodec)
find_package(libwebrtc REQUIRED)      # Google libwebrtc 또는 webrtc.lib
find_package(onnxruntime REQUIRED)    # ONNX Runtime C API
find_package(nlohmann_json REQUIRED)  # JSON
find_package(CURL REQUIRED)           # HTTP (WHEP 시그널링)
```

```cpp
// RTSP → H264 패킷 추출 (libav)
AVFormatContext* fmt_ctx = nullptr;
avformat_open_input(&fmt_ctx, rtsp_url.c_str(), nullptr, nullptr);
avformat_find_stream_info(fmt_ctx, nullptr);

int video_stream = av_find_best_stream(fmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
AVCodecContext* codec_ctx = avcodec_alloc_context3(nullptr);
avcodec_open2(codec_ctx, avcodec_find_decoder(fmt_ctx->streams[video_stream]->codecpar->codec_id), nullptr);

AVPacket pkt;
while (av_read_frame(fmt_ctx, &pkt) >= 0) {
    if (pkt.stream_index == video_stream) {
        // H264 NAL 유닛 → RTP 패킷 생성 → SFU로 전달
        rtp_packetizer_.PacketizeH264(pkt.data, pkt.size, [&](const uint8_t* rtp, size_t len) {
            sfu_transport_.SendRtp(rtp, len);
        });
    }
    av_packet_unref(&pkt);
}

// ONNX 추론 (ONNX Runtime C API)
OrtEnv* env;
OrtApi* ort_api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
ort_api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "yolo", &env);
```

---

### 6.5 Java (Spring Boot) — 권장 스택

```xml
<!-- pom.xml -->
<dependency>
    <groupId>io.github.jitsi</groupId>
    <artifactId>jitsi-videobridge</artifactId>  <!-- Janus 대체 Java SFU -->
</dependency>
<dependency>
    <groupId>com.microsoft.onnxruntime</groupId>
    <artifactId>onnxruntime</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-webflux</artifactId>
</dependency>
```

```java
@RestController
public class WhepController {

    @PostMapping(value = "/api/webrtc/whep/{cameraId}",
                 consumes = "application/sdp",
                 produces = "application/sdp")
    public ResponseEntity<String> handleWhep(
            @PathVariable String cameraId,
            @RequestBody String sdpOffer) {

        // JVB(Jitsi Video Bridge) 또는 자체 ICE/DTLS 구현을 통한 SDP 교환
        PeerConnection pc = sfuService.createPeerConnection(cameraId);
        String sdpAnswer = pc.negotiate(sdpOffer);
        return ResponseEntity.status(201)
                .contentType(MediaType.parseMediaType("application/sdp"))
                .body(sdpAnswer);
    }
}
```

---

## 7. 저장 레이어 설계

### 7.1 영상 세그먼트 저장

```
미디어 릴레이 (MediaMTX / 자체)
        │
        │ HLS segmenter 또는 fMP4 muxer
        ▼
┌─────────────────────────────────────┐
│  세그먼트 파일                       │
│  /recordings/{cameraId}/            │
│    YYYY-MM-DD/HH/                   │
│      {cameraId}_{ts}.mp4  (10~30초) │
└───────────────────────┬─────────────┘
                        │
                        ▼
              Object Storage 업로드
              (로컬 MinIO / AWS S3 / GCS)
```

**구현 선택 (인프로세스 방식만 허용):**

- **MediaMTX 내장 레코딩** (권장): `mediamtx.yml`에 `record: yes` 설정 — 릴레이 프로세스가 직접 세그먼트 생성
  ```yaml
  pathDefaults:
    record: yes
    recordPath: /recordings/%path/%Y%m%d_%H%M%S-%f
    recordFormat: mp4
    recordSegmentDuration: 30s
  ```
- **GStreamer splitmuxsink** (인프로세스): 인제스트 파이프라인의 녹화 스레드(tee 분기)
  ```
  t. ! queue ! h264parse ! splitmuxsink
       location=/recordings/seg_%05d.mp4 max-size-time=30000000000
  ```
- **libav C API** (인프로세스): 녹화 스레드에서 AVFormatContext write loop

### 7.2 메타데이터 스키마

```json
{
  "eventId": "uuid-v4",
  "cameraId": "camera-uuid",
  "cameraName": "Main Entrance",
  "frameId": 12345,
  "timestamp": 1718192000123,
  "type": "loitering",
  "zoneId": "zone-uuid",
  "zoneName": "Restricted Area",
  "objectId": 42,
  "className": "person",
  "confidence": 0.92,
  "bbox": { "x": 120, "y": 80, "width": 60, "height": 180 },
  "dwellTimeSec": 45.2,
  "riskScore": 0.78,
  "thumbnailPath": "/snapshots/2024/01/15/cam1_42_1718192000.jpg",
  "segmentPath": "s3://bucket/recordings/cam1/20240115_140000.mp4",
  "segmentOffset": 12.3
}
```

### 7.3 재생 경로 (Playback)

```
클라이언트 재생 요청 (timestamp + cameraId)
          │
          ▼
┌─────────────────────────────────────┐
│   재생 API                           │
│   GET /api/playback?cam=X&ts=Y      │
│                                     │
│   1. DB에서 세그먼트 경로 조회         │
│      (timestamp overlaps segment)   │
│                                     │
│   2. 영상 URL 생성                   │
│      (S3 presigned URL 또는 HLS 링크)│
│                                     │
│   3. 메타데이터 오버레이 데이터 반환   │
│      (해당 구간의 이벤트 목록)         │
└─────────────────────────────────────┘
          │                   │
          ▼                   ▼
   HLS/fMP4 스트리밍        메타데이터 JSON
   (seek 가능)              (타임라인 오버레이용)
```

---

## 8. 현재 구현 vs 이 아키텍처 비교

| 항목 | 현재 구현 (LTS-2026) | 이 아키텍처 완전 구현 시 |
|---|---|---|
| 언어/런타임 | Node.js 18+ | 언어 무관 |
| RTSP 릴레이 | MediaMTX (Go 바이너리) | 동일 또는 자체 구현 |
| 캡처 백엔드 | GStreamer / PyAV / libav (인프로세스) | 동일 + gortsplib / retina (Rust) |
| WebRTC SFU | mediasoup / mediamtx WHEP | + Janus / pion / str0m |
| AI 추론 | ONNX Runtime (CPU/GPU) | + TensorRT / OpenVINO |
| 추적 | ByteTrack (JS 포트) | + 원본 C++ ByteTrack |
| 저장 | JSON 파일 / MongoDB | + S3/MinIO + 영상 세그먼트 |
| 재생 | 미구현 | HLS + 메타데이터 오버레이 |
| 분산 | streaming/analysis 2-tier | + Kafka + 수평 확장 |
| 얼굴 Re-ID | 인메모리 갤러리 | + Qdrant 벡터 DB |

---

## 9. 구현 시 주의사항

### 9.1 단일 인제스트 프로세서 원칙

카메라 대부분은 동시 RTSP 연결을 2~4개로 제한하며, 연결 수가 많을수록 카메라 CPU·메모리 부하가 증가합니다.

**인제스트 프로세서는 카메라당 반드시 1개(단일 프로세스)이고, 내부 멀티스레드로 소비자에게 분배해야 합니다.**

```
권장 (단일 연결 · 내부 팬아웃):
  카메라 ──(1)──► IngestProcessor [멀티스레드]
                       ├── Thread-AI     → YOLO
                       ├── Thread-WebRTC → SFU RTP
                       └── Thread-Record → MP4 mux

금지 (복수 직접 연결 — 각각 별도 프로세스):
  카메라 ──(1)──► 프로세스-AI     → YOLO
  카메라 ──(2)──► 프로세스-WebRTC → SFU    ← 카메라 부하 2배
```

**loopback RTSP 허용 범위**: MediaMTX 패턴처럼 loopback(127.0.0.1)을 통한 복수 소비자 연결은 카메라 부하 없이 서버 내부에서만 발생하므로 허용됩니다. 단, 이 경우에도 MediaMTX(또는 relay)→카메라 연결은 1개여야 합니다.

### 9.2 ICE/UDP 방화벽
WebRTC ICE 미디어는 UDP를 사용합니다. 서버 방화벽에서 반드시 개방해야 합니다:
- MediaMTX: `UDP 8189`
- mediasoup: `UDP 40000–49999` (또는 설정한 범위)

### 9.3 DTLS 역할 (setup 속성)
```
브라우저 offer:  a=setup:actpass  (둘 다 가능)
서버 answer:     a=setup:passive  (서버는 항상 passive)
→ 브라우저가 DTLS ClientHello 먼저 전송
```

### 9.4 RTP → SRTP 전환
SFU PlainTransport (비암호화)와 WebRtcTransport (SRTP 암호화)는 SFU 내부에서 자동 변환됩니다. 구현 언어에서 직접 SRTP를 구현할 필요는 없으며, pion/webrtc, aiortc, str0m 등의 라이브러리가 처리합니다.

### 9.5 H.264 패킷화 모드
```
packetization-mode=1  ← 반드시 사용 (브라우저 호환)
profile-level-id=42e01f  ← Constrained Baseline (최호환)
libx264 파라미터: profile=baseline level=3.1 (libav / GStreamer x264enc 공통)
```

---

## 10. 미구현 항목 Milestone

> §8 비교표와 각 섹션 설계를 기준으로, LTS-2026에서 **아직 구현되지 않은 항목**을 Milestone으로 정리합니다.  
> 우선순위: `P1`(운영 필수) · `P2`(품질 향상) · `P3`(확장성)

---

### Milestone 1 — 영상 녹화 및 세그먼트 저장 `P1`

**관련 섹션**: §7.1 영상 세그먼트 저장  
**현재 상태**: 미구현 (스냅샷 JPEG 저장만 있음, `snapshotService.js`)

| 항목 | 설명 |
|---|---|
| MediaMTX 내장 녹화 활성화 | `mediamtx.yml` — `record: yes`, `recordPath`, `recordSegmentDuration: 30s` 설정 |
| 세그먼트 파일 구조 | `/recordings/{cameraId}/YYYY-MM-DD/HH/{cameraId}_{ts}.mp4` |
| Object Storage 업로드 | 세그먼트 완성 시 S3/MinIO로 비동기 업로드 (로컬 MinIO 우선) |
| 업로드 서비스 | `server/src/services/recordingService.js` 신규 작성 |
| 세그먼트 메타데이터 DB 저장 | `storage/lts.json` → `recordings` 컬렉션 (시작 ts, 종료 ts, 경로, 카메라ID) |

**구현 포인트:**
```yaml
# mediamtx.yml 추가 설정
pathDefaults:
  record: yes
  recordPath: ./recordings/%path/%Y%m%d_%H%M%S-%f
  recordFormat: mp4
  recordSegmentDuration: 30s
```
```javascript
// server/src/services/recordingService.js (신규)
// MediaMTX webhook or filesystem watcher → S3/MinIO 업로드
```

---

### Milestone 2 — 재생(Playback) API `P1`

**관련 섹션**: §7.3 재생 경로  
**현재 상태**: **명시적 미구현** (§8 비교표: "미구현")

| 항목 | 설명 |
|---|---|
| 재생 API 엔드포인트 | `GET /api/playback?cam={id}&ts={unix_ms}` |
| 세그먼트 조회 로직 | DB에서 timestamp 범위에 해당하는 세그먼트 경로 반환 |
| 영상 URL 생성 | S3 presigned URL 또는 MediaMTX HLS URL 반환 |
| 메타데이터 오버레이 | 해당 구간 이벤트 목록(bbox, zone 진입 등) JSON 반환 |
| 클라이언트 타임라인 UI | `client/src/components/PlaybackTimeline.tsx` 신규 작성 |

**API 설계 (신규):**
```
GET  /api/playback?cam=cam-01&ts=1718192000000
→ { videoUrl: "https://minio/recordings/...", events: [...], segmentStart: ..., segmentEnd: ... }

GET  /api/playback/segments?cam=cam-01&from=...&to=...
→ [{ path, startTs, endTs, durationSec }]
```

---

### Milestone 3 — Qdrant 벡터 DB 기반 얼굴 Re-ID 고도화 `P2`

**관련 섹션**: §8 비교표 ("인메모리 갤러리" → "Qdrant 벡터 DB")  
**현재 상태**: `faceService.js`에서 인메모리 배열 + 코사인 유사도 탐색

| 항목 | 설명 |
|---|---|
| Qdrant 또는 pgvector 연동 | 얼굴 임베딩 벡터 인덱스 (HNSW) — 서버 재시작 후에도 유지 |
| `faceService.js` 리팩터 | 인메모리 `gallery[]` → Qdrant REST API 또는 pgvector 쿼리로 교체 |
| 배치 등록 API | `POST /api/faces/import` — 기존 `face_tracking.json` 마이그레이션 |
| 유사도 임계값 튜닝 | Qdrant `score_threshold` 파라미터로 FP/FN 제어 |

```javascript
// faceService.js 교체 대상 (현재)
const gallery = [];  // ← 인메모리
const match = gallery.find(f => cosineSim(f.embedding, query) > THRESHOLD);

// 목표 구현 (Qdrant)
const result = await qdrant.search('faces', { vector: queryEmbedding, limit: 1, score_threshold: 0.85 });
```

---

### Milestone 4 — RTCP 피드백 처리 (NACK / PLI / REMB) `P2`

**관련 섹션**: §5.2 ICE/DTLS/SRTP 연결 순서 (`← RTCP (NACK/PLI/REMB)` 라인)  
**현재 상태**: MediaMTX WHEP이 기본 RTCP를 처리하지만 PLI/REMB 기반 화질 적응 로직 미구현

| 항목 | 설명 |
|---|---|
| PLI (Picture Loss Indication) 처리 | 브라우저 PLI 수신 시 ingest-daemon에게 키프레임 요청 전달 |
| REMB (Receiver Estimated Max Bitrate) | 네트워크 상태에 따라 MediaMTX 또는 카메라 비트레이트 동적 조정 |
| NACK 재전송 버퍼 | 패킷 손실 구간 재전송 (현재 MediaMTX 기본 동작에 위임) |
| AI 프레임 드롭 감지 | RTCP 통계 기반 스트림 품질 지표 → `cameraStatus` Socket.IO 이벤트에 포함 |

```javascript
// server/src/services/mediamtxManager.js 확장 계획
// MediaMTX WebRTC stats API 폴링 → AI 파이프라인에 품질 지표 전달
GET http://localhost:9997/v3/whepsessions/list
→ { bytesReceived, nackCount, pliCount, ... }
```

---

### Milestone 5 — 분산 클러스터 모드 `P3`

**관련 섹션**: §4.3 분산 클러스터 모드  
**현재 상태**: streaming/analysis 2-tier 분리만 구현 (`SERVER_MODE=streaming|analysis`)

| 항목 | 설명 |
|---|---|
| 메시지 큐 연동 | Kafka 또는 AMQP — 스트리밍 노드 → 분석 클러스터 JPEG 프레임 전달 |
| 로드 밸런서 설정 | nginx / Traefik — 카메라 그룹별 스트리밍 노드 라우팅 |
| GPU 노드 풀 | Ray Serve 또는 Celery — 분석 서버 수평 확장 |
| 공유 저장소 | MongoDB Atlas 또는 로컬 MongoDB 복제셋 + MinIO 분산 모드 |
| 노드 상태 레지스트리 | 스트리밍 노드 등록/탈락 감지 → 카메라 재배치 로직 |

```
현재 (2-tier):
  streaming-server → HTTP POST → analysis-server (단일)

목표 (cluster):
  streaming-node-1 ─┐
  streaming-node-2 ─┼─► Kafka topic: frames → analysis-worker-pool (N개)
  streaming-node-N ─┘                              └─► 결과 → shared DB
```

---

### Milestone 요약

| Milestone | 항목 | 우선순위 | 예상 영향 |
|---|---|---|---|
| M1 | 영상 녹화 + Object Storage | P1 | 사건 증거 보존 기능 확보 |
| M2 | Playback API + 타임라인 UI | P1 | 과거 영상 검색·재생 기능 |
| M3 | Qdrant 벡터 DB Re-ID | P2 | 서버 재시작 후 Re-ID 연속성 |
| M4 | RTCP 피드백 처리 | P2 | 네트워크 불안정 환경 화질 개선 |
| M5 | 분산 클러스터 모드 | P3 | 카메라 100대 이상 수평 확장 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 작성 — 현재 LTS-2026 구현 기반의 언어 독립적 아키텍처 문서화 |
| 1.1 | 2026-06-11 | 인제스트 프로세서 단일·멀티스레드 원칙 명시 — 섹션 1.1 다이어그램, 2.1 Live Path, 2.2 팬아웃 패턴(A~D), 9.1 원칙 보강 |
| 1.2 | 2026-06-11 | ffmpeg subprocess 전면 제거 — 인프로세스 라이브러리(libav/GStreamer/gortsplib)로 대체; 3.1 표·권장 재작성, 7.1 녹화 방법 교체 |
| 1.3 | 2026-06-11 | §10 미구현 항목 Milestone 추가 — M1(영상 녹화), M2(Playback), M3(Qdrant Re-ID), M4(RTCP 피드백), M5(분산 클러스터) |
| 1.4 | 2026-06-11 | §3.7 Application RTP → WebRTC DataChannel 브리지 추가 — 프로토콜 비교, 변환 경로, DataChannel 신뢰성 설정, MediaMTX WHEP 한계 명시 |
| 1.5 | 2026-06-11 | §0 수집 레이어 불변 원칙 추가 — ingest-daemon 우선 원칙, 팬아웃 설계, FFmpeg 금지 범위 명시 |
| 1.6 | 2026-06-11 | §0.2/§0.3 이중 엔진 데이터 경로 상세화 — 비디오/오디오/App RTP 팬아웃 다이어그램, WEBRTC_ENGINE별 전달 경로 표 추가 |
| 1.7 | 2026-06-25 | §0.2 mediasoup 모드 직접 연결 반영 — MediaMTX relay 제거, 카메라 직접 PyAV 단일 세션 팬아웃으로 변경; pipelineManager.js needsMediaMTX 조건 정렬 |
