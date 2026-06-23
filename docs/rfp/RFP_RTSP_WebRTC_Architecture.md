# RFP — RTSP → WebRTC 실시간 AI 스트리밍 아키텍처
**Document ID**: RFP-LTS-RWA-01  
**Version**: 1.0  
**Date**: 2026-06-11  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Under Evaluation  
**Author**: LTS Engineering Team

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 작성 — ingest-daemon + MediaMTX 현재 구현 기반, M1–M5 Milestone 평가 포함 |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Background — Current Architecture](#2-background--current-architecture)
3. [Problem Statement](#3-problem-statement)
4. [Technology Evaluation](#4-technology-evaluation)
5. [Full Comparison Matrix](#5-full-comparison-matrix)
6. [Recommended Roadmap](#6-recommended-roadmap)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Risk Assessment](#8-risk-assessment)
9. [Related Documents](#9-related-documents)

---

## 1. Overview

LTS-2026의 RTSP → WebRTC 아키텍처는 IP 카메라 스트림을 수신하여 AI 추론(YOLOv8 ONNX)과 브라우저 실시간 WebRTC 영상 제공을 동시에 처리하는 핵심 파이프라인입니다.

현재 LTS-2026은 **ingest-daemon(Python PyAV) + MediaMTX WHEP** 조합으로 핵심 라이브 스트리밍을 구현했습니다. 카메라당 단일 RTSP 연결 원칙을 준수하고, 브라우저는 MediaMTX의 WHEP 엔드포인트(`/api/whep/:camId`)를 통해 WebRTC로 영상을 수신합니다.

그러나 다음 기능이 미구현 상태로 남아 있어 운영 수준(production-grade) 시스템으로 성장하는 데 제약이 됩니다:

- **M1**: 영상 녹화 + Object Storage(S3/MinIO) 세그먼트 저장
- **M2**: Playback API(`GET /api/playback`) + 타임라인 UI
- **M3**: Qdrant 벡터 DB 기반 얼굴 Re-ID 영속화
- **M4**: RTCP NACK/PLI/REMB 피드백 처리
- **M5**: 분산 클러스터 모드(Kafka + 수평 확장)

본 문서는 현재 구현을 기록하고 각 미구현 항목에 대한 기술 평가와 구현 로드맵을 제시합니다.

---

## 2. Background — Current Architecture

### 2.1 전체 파이프라인 흐름

```
[IP Camera / YouTube]
        │ RTSP (H.264 + AAC/G.711)
        ▼
┌────────────────────────────────────────────────────────────┐
│  MediaMTX (Go 바이너리, 외부 프로세스)                        │
│                                                            │
│  pull: 카메라 RTSP → 단일 연결 유지                          │
│  ├─ RTSP loopback  :8554/{camId}  ← ingest-daemon 소비     │
│  ├─ WHEP           :8889/{camId}  ← 브라우저 직접 WebRTC    │
│  ├─ HLS            :8888/{camId}  ← 선택적 녹화/VOD         │
│  └─ REST API       :9997           ← 경로 동적 등록         │
└──────────────────────┬─────────────────────────────────────┘
                       │ RTSP loopback (127.0.0.1:8554)
                       ▼
┌────────────────────────────────────────────────────────────┐
│  ingest_daemon.py (Python PyAV)                            │
│                                                            │
│  av.open(rtsp://127.0.0.1:8554/{camId})                   │
│  → JPEG 디코드 (10 fps, 640px wide)                        │
│  → HTTP POST /ingest/{camId} → Node.js                    │
│  → IngestDaemonCapture.injectFrame(buf)                   │
│  → EventEmitter.emit('frame', buf)                        │
└──────────────────────┬─────────────────────────────────────┘
                       │ JPEG frame buffer
                       ▼
┌────────────────────────────────────────────────────────────┐
│  pipelineManager.js                                        │
│                                                            │
│  detection.js  YOLOv8 ONNX 640×640 추론                   │
│  tracking.js   ByteTrack + KalmanFilter                   │
│  behaviorEngine.js  배회 위험 점수 산출                     │
│  zoneManager.js     다각형 구역 + 이벤트 발생               │
│  alertService.js    알림 생성·에스컬레이션                  │
└──────────────────────┬─────────────────────────────────────┘
                       │ Socket.IO
                       ▼
[React WebUI]
  ├─ <video> element   ← MediaMTX WHEP (WebRTC)
  ├─ frameData event   ← Socket.IO (JPEG 오버레이)
  └─ newAlert / objectTracked  ← Socket.IO
```

### 2.2 captureFactory 및 CAPTURE_BACKEND

`captureFactory.js`는 `CAPTURE_BACKEND` 환경변수에 따라 캡처 인스턴스를 생성합니다.

| CAPTURE_BACKEND | 구현 파일 | 설명 |
|---|---|---|
| `ingest-daemon` (권장) | `ingestDaemonCapture.js` | Python PyAV → HTTP POST → EventEmitter |
| `ffmpeg` | `rtspCapture.js` | FFmpeg subprocess (레거시, 폴백) |
| `gstreamer` | `gstreamerCapture.js` | GStreamer subprocess (HW 가속) |
| `pyav` | `pyavCapture.js` | Python PyAV 직접 subprocess |
| `mediamtx-snapshot` | `mediamtxSnapshotCapture.js` | MediaMTX JPEG 스냅샷 API |

### 2.3 WebRTC 엔진: WEBRTC_ENGINE=mediamtx

현재 `WEBRTC_ENGINE=mediamtx` 설정 시, 브라우저는 MediaMTX WHEP 엔드포인트에 직접 SDP offer를 보내고 MediaMTX가 WebRTC(Pion Go 기반) 처리를 담당합니다.

```
브라우저
  │ POST /api/whep/:camId (SDP offer)
  ▼
Node.js (mediamtxManager.js) → 프록시 → MediaMTX :8889/{camId}/whep
  ← SDP answer (HTTP 201)
  │
  │ ICE/DTLS/SRTP (UDP :8189)
  └─ 브라우저 <video> 재생
```

### 2.4 mediamtxManager.js 역할

`mediamtxManager.js`는 MediaMTX REST API(`:9997`)를 통해 카메라 경로를 동적으로 등록·해제합니다.

```javascript
// 카메라 시작 시 경로 등록
POST http://localhost:9997/v3/config/paths/add/{camId}
{ source: "rtsp://camera-ip/stream", sourceOnDemand: false }

// 카메라 중지 시 경로 해제
DELETE http://localhost:9997/v3/config/paths/remove/{camId}
```

### 2.5 포트 구성

| 서비스 | 포트 | 프로토콜 | 용도 |
|---|---|---|---|
| HTTP API | 3080 | TCP | REST API / Socket.IO |
| HTTPS API | 3443 | TCP | REST API (TLS) |
| MediaMTX RTSP | 8554 | TCP | loopback 재스트림 |
| MediaMTX WHEP | 8889 | TCP | WebRTC 시그널링 |
| MediaMTX ICE | 8189 | UDP | 브라우저 ICE 미디어 |
| MediaMTX API | 9997 | TCP | 경로 등록 REST |
| ingest-daemon | 7070 | TCP | JPEG POST 수신 |

---

## 3. Problem Statement

### 3.1 미구현 항목으로 인한 비즈니스 임팩트

#### 3.1.1 M1 — 영상 녹화 부재 (P1 — 운영 필수)

현재 LTS-2026은 JPEG 스냅샷(`snapshotService.js`)만 저장하며 연속 영상 녹화 기능이 없습니다.

| 영향 | 내용 |
|---|---|
| 증거 보존 불가 | 배회·침입 사건 발생 시 영상 증거 제출 불가 |
| 규제 준수 위험 | 보안 시스템 영상 보관 의무(최소 30일) 미충족 가능성 |
| 사후 분석 불가 | 알림 발생 전후 영상 맥락 확인 불가 |
| 고객 신뢰도 저하 | "녹화가 안 되는 보안 시스템"으로 인식 |

#### 3.1.2 M2 — Playback API 부재 (P1 — 운영 필수)

재생 API 미구현으로 과거 영상 검색·재생 기능이 완전히 부재합니다.

| 영향 | 내용 |
|---|---|
| 운영자 업무 비효율 | 사건 조사 시 NVR 장비에 별도 접근 필요 |
| 통합 워크플로우 부재 | 알림 클릭 → 해당 시점 영상 재생 불가 |
| 경쟁력 열위 | 타 보안 솔루션 대비 핵심 기능 부재 |

#### 3.1.3 M3 — 인메모리 얼굴 Re-ID 한계 (P2)

현재 `faceService.js`는 인메모리 배열(`gallery[]`)에 임베딩을 저장합니다.

| 영향 | 내용 |
|---|---|
| 서버 재시작 시 Re-ID 데이터 손실 | `face_tracking.json` 백업만 있으며 벡터 인덱스 미구축 |
| 수천 명 규모 탐색 성능 저하 | 선형 탐색 O(N) — 갤러리 확장 시 레이턴시 급증 |
| 등록 얼굴 수 증가 시 메모리 압박 | 임베딩 벡터가 증가할수록 Node.js 힙 사용 증가 |

#### 3.1.4 M4 — RTCP 피드백 처리 부재 (P2)

현재 MediaMTX가 기본 RTCP를 처리하지만, 애플리케이션 레벨에서 네트워크 품질 적응 로직이 없습니다.

| 영향 | 내용 |
|---|---|
| 열악한 네트워크 환경에서 화질 저하 | PLI/REMB 기반 비트레이트 적응 없음 |
| 패킷 손실 감지 어려움 | NACK 통계가 AI 파이프라인 품질 지표와 미연동 |
| 스트림 복구 지연 | 브라우저 영상 깨짐 시 키프레임 강제 요청 메커니즘 없음 |

#### 3.1.5 M5 — 단일 서버 확장 한계 (P3)

현재 `streaming/analysis` 2-tier 분리를 지원하지만, 카메라 50대 이상 처리 시 단일 스트리밍 서버 병목이 예상됩니다.

| 영향 | 내용 |
|---|---|
| 수평 확장 불가 | 스트리밍 노드 추가 시 카메라 라우팅 정책 없음 |
| 단일 장애점 | 스트리밍 서버 장애 시 전체 카메라 영상 불가 |
| 대규모 고객사 수주 제한 | 100대 이상 카메라 요구 사항 충족 불가 |

---

## 4. Technology Evaluation

### 4.1 인제스트 백엔드

#### 4.1.1 libav C API (libavformat/libavcodec)

**개요**: FFmpeg의 핵심 라이브러리를 인프로세스(in-process) 방식으로 직접 호출합니다. ffmpeg 바이너리를 subprocess로 실행하는 방식과 근본적으로 다릅니다.

| 항목 | 평가 |
|---|---|
| 언어 지원 | C / C++ / Rust(rsmpeg) / Java(JavaCV) |
| RTSP 처리 | libavformat — avformat_open_input(), av_read_frame() |
| 하드웨어 가속 | CUDA(nvdec), VAAPI, VideoToolbox 인프로세스 지원 |
| 멀티스레드 팬아웃 | av_packet_clone() → 복수 소비자 큐로 분배 |
| 코덱 지원 | H.264/H.265/MJPEG/VP8/VP9 등 광범위 |
| 의존성 | libav 개발 헤더 (대부분 Linux에 기본 제공) |
| Node.js 통합 | N-API 또는 child_process → Node.js 네이티브 애드온 필요 |
| **결론** | **최고 성능. C++/Rust 서버에 이상적. 현재 Node.js 환경에서는 N-API 바인딩 작성 비용 높음** |

#### 4.1.2 GStreamer appsink (인프로세스)

**개요**: GStreamer 파이프라인을 프로세스 내 라이브러리로 호출하여 RTSP 수신, 디코딩, 팬아웃을 단일 파이프라인으로 처리합니다.

**현재 LTS-2026 구현 상태**: `gstreamerCapture.js`로 부분 구현됨 (CAPTURE_BACKEND=gstreamer, subprocess 방식)

```
# 인프로세스 권장 패턴 (tee 팬아웃)
rtspsrc location=rtsp://... name=src
  ! queue ! tee name=t

t. ! queue ! nvh264dec ! jpegenc ! appsink name=ai_sink
t. ! queue ! rtph264pay pt=96 ! udpsink host=127.0.0.1 port=5004
t. ! queue ! h264parse ! splitmuxsink location=rec_%05d.mp4 max-size-time=30000000000
```

| 항목 | 평가 |
|---|---|
| 언어 지원 | C / Python(gst-python) / Rust(gstreamer-rs) |
| RTSP 처리 | rtspsrc 플러그인 |
| 하드웨어 가속 | nvdec(NVIDIA), vaapi(Intel/AMD) — 현재 gstreamerCapture.js에 구현됨 |
| 멀티스레드 팬아웃 | tee 엘리먼트 — AI / WebRTC / 녹화 동시 처리 |
| 의존성 | gstreamer1.0-plugins-good/bad/ugly |
| Node.js 통합 | subprocess 호출 또는 gst-python → HTTP bridge |
| **결론** | **현재 부분 구현. tee 기반 팬아웃으로 M1(녹화) 경로 확장 용이** |

#### 4.1.3 PyAV (Python libav 바인딩)

**개요**: Python에서 libav C API를 래핑한 `av` 패키지입니다. 현재 `ingest_daemon.py`가 이 방식으로 동작합니다.

| 항목 | 평가 |
|---|---|
| 언어 지원 | Python 3.8+ |
| RTSP 처리 | av.open() — libavformat 기반 |
| 하드웨어 가속 | CUDA(codec_context.options), VAAPI 지원 |
| 멀티스레드 팬아웃 | Python GIL 제약 — asyncio 또는 멀티프로세싱 필요 |
| 의존성 | pip install av (libav 정적 링크 배포됨) |
| Node.js 통합 | HTTP POST (현재 구현: ingest_daemon.py → :7070) |
| **결론** | **현재 권장 백엔드. 안정적이며 Node.js와 HTTP 통신으로 깔끔하게 분리됨** |

#### 4.1.4 gortsplib (Go 네이티브)

**개요**: Go 언어 전용 RTSP 클라이언트/서버 라이브러리로, MediaMTX 내부에서도 사용됩니다.

| 항목 | 평가 |
|---|---|
| 언어 지원 | Go 1.21+ |
| RTSP 처리 | bluenviron/gortsplib v4 |
| 하드웨어 가속 | Go 레이어에서 직접 미지원 (CGO로 libav 호출 가능) |
| 멀티스레드 팬아웃 | 고루틴 채널 — select/non-blocking 전송 |
| 의존성 | Go 런타임 + gortsplib 모듈 |
| Node.js 통합 | HTTP 또는 gRPC 브리지 필요 |
| MediaMTX 관계 | MediaMTX가 gortsplib 기반 — 직접 사용 시 MediaMTX 구현과 중복 |
| **결론** | **Go 서비스 별도 구축 시 최적. 현재 Node.js 환경에서는 MediaMTX 사용이 더 효율적** |

---

### 4.2 미디어 릴레이 (RTSP → WebRTC 브리지)

#### 4.2.1 MediaMTX (현재 구현, 권장)

**개요**: Go 기반 범용 미디어 서버. 현재 LTS-2026에서 실행 중이며 RTSP 수신, WHEP WebRTC 출력, HLS, REST API를 단일 프로세스로 제공합니다.

| 항목 | 평가 |
|---|---|
| WebRTC 엔진 | Pion(Go 네이티브) — ICE/DTLS/SRTP 내장 |
| RTSP 재스트림 | loopback :8554 — AI 소비자 연결 가능 |
| WHEP 지원 | 네이티브 내장 |
| HLS/MP4 녹화 | 내장 (`record: yes`) |
| REST API | :9997 — 경로 동적 등록/해제/통계 조회 |
| ICE 설정 | mediamtx.yml에서 STUN/TURN 독립 설정 |
| 의존성 | **이미 실행 중** — 추가 설치 불필요 |
| 구현 복잡도 | 낮음 — mediamtxManager.js로 경로 등록만 관리 |
| **결론** | **현재 사용 중. 최선의 선택. M1 녹화도 내장 기능으로 즉시 구현 가능** |

#### 4.2.2 Janus Gateway (C 기반 독립 프로세스)

**개요**: C로 작성된 범용 WebRTC 미디어 서버. 플러그인 아키텍처로 videoroom, streaming, recording 플러그인을 제공합니다.

| 항목 | 평가 |
|---|---|
| WebRTC 엔진 | 자체 ICE/DTLS/SRTP 구현 |
| RTSP 입력 | streaming 플러그인 — GStreamer RTP 입력 |
| WHEP 지원 | 플러그인 추가 필요 (기본 미지원) |
| 녹화 | recordplay 플러그인 |
| REST API | Admin API |
| 의존성 | 독립 설치 필요 (apt/yum 또는 소스 빌드) |
| 구현 복잡도 | 높음 — 플러그인 설정, 시그널링 커스텀 구현 필요 |
| **결론** | **MediaMTX 대비 복잡도 높음. 현재 MediaMTX로 충분하므로 도입 불필요** |

#### 4.2.3 자체 구현 (Go/Rust + pion/webrtc)

**개요**: pion/webrtc(Go) 또는 str0m(Rust) 라이브러리로 완전 자체 SFU를 구현하는 방안입니다.

| 항목 | 평가 |
|---|---|
| 유연성 | 최고 — 모든 동작을 코드로 제어 |
| 구현 비용 | 매우 높음 — ICE, DTLS, SRTP 통합 필요 |
| 의존성 | 최소 — 라이브러리 + Go/Rust 런타임 |
| MediaMTX 대비 | MediaMTX가 이미 pion/webrtc 기반으로 동일 기능 제공 |
| **결론** | **현재 불필요. MediaMTX가 이미 pion 기반으로 동일 기능 제공** |

---

### 4.3 Object Storage (M1 — 녹화 저장소)

#### 4.3.1 MinIO (로컬 배포, 권장)

| 항목 | 평가 |
|---|---|
| API 호환성 | AWS S3 완전 호환 |
| 배포 방식 | Docker 단일 컨테이너 또는 분산 모드 |
| 비용 | 오픈소스, 무료 |
| 성능 | 단일 서버 기준 10 Gbps+ |
| 관리 UI | MinIO Console 내장 |
| Node.js 연동 | `@aws-sdk/client-s3` — S3 API 동일 |
| **결론** | **온프레미스 환경 1순위. Docker compose에 추가하면 즉시 사용 가능** |

#### 4.3.2 AWS S3

| 항목 | 평가 |
|---|---|
| API 호환성 | S3 표준 |
| 배포 방식 | AWS 관리형 서비스 |
| 비용 | GB당 $0.023/월 (us-east-1 기준) |
| 내구성 | 99.999999999% (11 nines) |
| 오프라인 환경 | 인터넷 연결 필요 — 폐쇄망 환경 불가 |
| **결론** | **클라우드 배포 환경에 적합. 온프레미스에는 MinIO 사용** |

---

### 4.4 벡터 DB (M3 — 얼굴 Re-ID 영속화)

#### 4.4.1 Qdrant (권장)

**개요**: Rust로 작성된 고성능 벡터 유사도 검색 엔진. HNSW 인덱스 기반으로 수백만 벡터도 밀리초 내 탐색합니다.

| 항목 | 평가 |
|---|---|
| 배포 방식 | Docker 단일 컨테이너 (`qdrant/qdrant`) |
| API | REST + gRPC |
| 인덱스 | HNSW (Hierarchical Navigable Small World) |
| 필터링 | 페이로드 필터(카메라ID, 시간 범위) + 벡터 탐색 결합 |
| Node.js 연동 | `@qdrant/js-client-rest` npm 패키지 |
| 영속성 | 디스크 영속화 기본 지원 |
| 메모리 효율 | 양자화(Scalar/Product) 지원 |
| **결론** | **M3 구현의 1순위. Docker compose에 추가하면 즉시 사용 가능** |

#### 4.4.2 pgvector (PostgreSQL 확장)

| 항목 | 평가 |
|---|---|
| 배포 방식 | PostgreSQL + pgvector 확장 |
| 기존 인프라 연동 | PostgreSQL 이미 사용 중인 경우 유리 |
| 벡터 탐색 | ivfflat 또는 HNSW 인덱스 |
| Node.js 연동 | `pg` 또는 `knex` — SQL 기반 |
| 관리 복잡도 | PostgreSQL 운영 지식 필요 |
| **결론** | **PostgreSQL 기반 환경에서 대안. 현재 JSON DB 환경에서는 Qdrant가 더 간단** |

---

## 5. Full Comparison Matrix

### 5.1 인제스트 백엔드 비교

| 기준 | ingest-daemon(PyAV) | libav C API | GStreamer appsink | gortsplib |
|---|---|---|---|---|
| **현재 구현** | ✅ 권장 | ❌ | 부분 (subprocess) | ❌ |
| **언어** | Python | C/C++/Rust/Java | C/Python/Rust | Go |
| **RTSP 처리** | libavformat | libavformat | rtspsrc | gortsplib |
| **HW 가속 디코딩** | CUDA/VAAPI 가능 | CUDA/VAAPI 인프로세스 | nvdec/vaapi 구현됨 | 미지원 (CGO 필요) |
| **멀티스레드 팬아웃** | asyncio | 스레드 큐 | tee 엘리먼트 | 고루틴 채널 |
| **Node.js 통합** | HTTP POST | N-API 바인딩 | HTTP bridge | HTTP/gRPC |
| **녹화 경로 추가** | HTTP → recordingService | 내부 소비자 큐 | tee → splitmuxsink | 고루틴 소비자 |
| **구현 복잡도** | 낮음 | 높음 | 중간 | 중간 |
| **의존성** | pip install av | libav-dev | gstreamer 플러그인 | go mod |

### 5.2 미디어 릴레이 비교

| 기준 | MediaMTX (현재) | Janus Gateway | 자체 구현 (pion) |
|---|---|---|---|
| **현재 구현** | ✅ 실행 중 | ❌ | ❌ |
| **WHEP 내장** | ✅ | 플러그인 필요 | 수동 구현 |
| **HLS/MP4 녹화** | ✅ 내장 | recordplay 플러그인 | 직접 구현 |
| **REST API** | ✅ :9997 | ✅ Admin API | 직접 구현 |
| **ICE 독립 설정** | ✅ mediamtx.yml | ✅ | ✅ |
| **추가 설치 필요** | ❌ 이미 실행 중 | ✅ 필요 | ✅ Go/Rust 서비스 |
| **구현 복잡도** | 낮음 | 높음 | 매우 높음 |
| **M1 녹화 지원** | ✅ record: yes | 플러그인 필요 | 직접 구현 |
| **M4 RTCP 통계** | ✅ /v3/whepsessions | 제한적 | 완전 제어 가능 |

### 5.3 Object Storage 비교

| 기준 | MinIO | AWS S3 | 로컬 파일시스템 |
|---|---|---|---|
| **배포 방식** | Docker | AWS 관리형 | 파일시스템 |
| **오프라인 가능** | ✅ | ❌ | ✅ |
| **Node.js SDK** | @aws-sdk/client-s3 | @aws-sdk/client-s3 | fs/promises |
| **비용** | 무료 (오픈소스) | 종량제 | 무료 |
| **내구성** | 구성에 따라 상이 | 99.999999999% | 단일 디스크 |
| **확장성** | 분산 모드 지원 | 무제한 | 디스크 한계 |
| **M1 구현 용이성** | 높음 | 높음 | 높음 (단순) |
| **권장 환경** | 온프레미스 | 클라우드 | 개발/소규모 |

### 5.4 벡터 DB 비교

| 기준 | Qdrant | pgvector | 인메모리 배열 (현재) |
|---|---|---|---|
| **현재 구현** | ❌ | ❌ | ✅ |
| **영속성** | ✅ 디스크 | ✅ PostgreSQL | ❌ 재시작 시 손실 |
| **검색 알고리즘** | HNSW | ivfflat / HNSW | 선형 탐색 O(N) |
| **100만 벡터 탐색** | < 10 ms | < 50 ms | > 1000 ms |
| **Node.js 연동** | @qdrant/js-client-rest | pg (SQL) | 인메모리 직접 접근 |
| **배포 방식** | Docker | PostgreSQL + 확장 | 코드 내장 |
| **필터+벡터 결합** | ✅ 페이로드 필터 | ✅ WHERE 절 | 수동 구현 |
| **구현 복잡도** | 낮음 | 중간 | 없음 |

---

## 6. Recommended Roadmap

### 6.1 Milestone 순서 및 선택 이유

```
M1 → M2 → M4 → M3 → M5
```

**M1 → M2 순서**: 녹화(M1)가 없으면 재생(M2)을 구현해도 데이터가 없습니다. 반드시 M1 완료 후 M2를 진행합니다.

**M4 우선**: M3(Qdrant)은 데이터 마이그레이션이 필요하지만, M4(RTCP)는 MediaMTX API 폴링만으로 즉시 구현 가능하며 스트림 품질에 직접적 영향을 줍니다.

**M5 후순위**: 분산 클러스터는 카메라 50대 이상 운영 시 필요한 항목으로, M1~M4 완료 후 안정화 이후 착수합니다.

---

### 6.2 M1 — 영상 녹화 + Object Storage 세그먼트 저장

**기간**: 1~2주  
**우선순위**: P1  
**구현 방법**: MediaMTX 내장 녹화 활성화 + recordingService.js 신규 작성

**단계별 구현**:

```
Step 1: mediamtx.yml 녹화 설정 활성화
─────────────────────────────────────
pathDefaults:
  record: yes
  recordPath: ./recordings/%path/%Y%m%d_%H%M%S-%f
  recordFormat: mp4
  recordSegmentDuration: 30s

Step 2: recordingService.js 신규 작성
─────────────────────────────────────
server/src/services/recordingService.js
  - MediaMTX webhook 또는 fs.watch()로 신규 세그먼트 감지
  - S3/MinIO 업로드 (AWS SDK v3)
  - DB에 세그먼트 메타데이터 저장 (camId, startTs, endTs, path)

Step 3: pipelineManager.js에 recordingService 등록
Step 4: Docker compose에 MinIO 서비스 추가
```

**아키텍처 변화**:
```
현재: MediaMTX → (녹화 없음)
변경: MediaMTX → record: yes → ./recordings/ → recordingService.js → MinIO/S3
```

---

### 6.3 M2 — Playback API + 타임라인 UI

**기간**: 1~2주 (M1 완료 후)  
**우선순위**: P1  
**구현 방법**: 신규 API 엔드포인트 + React 타임라인 컴포넌트

**API 설계**:
```
GET  /api/playback?cam={id}&ts={unix_ms}
→ { videoUrl, events, segmentStart, segmentEnd }

GET  /api/playback/segments?cam={id}&from={ts}&to={ts}
→ [{ path, startTs, endTs, durationSec }]
```

**클라이언트**:
```
client/src/components/PlaybackTimeline.tsx
  - HLS.js 또는 MediaMTX HLS URL 재생
  - 타임라인 슬라이더 (react-range 또는 자체 구현)
  - 이벤트 마커 (알림 발생 시점 오버레이)
```

---

### 6.4 M4 — RTCP 피드백 처리

**기간**: 3~5일 (M2 완료 후)  
**우선순위**: P2  
**구현 방법**: MediaMTX WHEP 세션 통계 API 폴링 + AI 파이프라인 품질 지표 연동

```javascript
// mediamtxManager.js 확장
// GET http://localhost:9997/v3/whepsessions/list
// → { bytesReceived, nackCount, pliCount, bytesSent }
// → cameraStatus Socket.IO 이벤트에 품질 지표 포함
```

---

### 6.5 M3 — Qdrant 벡터 DB 얼굴 Re-ID

**기간**: 2~3주 (M4 완료 후)  
**우선순위**: P2  
**구현 방법**: faceService.js 리팩터 + Docker compose에 Qdrant 추가

```
현재: faceService.js → gallery[] → 선형 탐색
변경: faceService.js → @qdrant/js-client-rest → Qdrant (HNSW)
```

**데이터 마이그레이션**:
```javascript
// face_tracking.json → Qdrant 일괄 업로드
POST /collections/faces/points
{ id, vector: embedding, payload: { cameraId, timestamp, personId } }
```

---

### 6.6 M5 — 분산 클러스터 모드

**기간**: 4~8주 (M1~M4 완료 후)  
**우선순위**: P3  
**조건**: 카메라 50대 이상 운영 또는 복수 스트리밍 서버 필요 시

```
현재 (2-tier):
  streaming-server → HTTP POST → analysis-server (단일)

목표 (cluster):
  streaming-node-1 ─┐
  streaming-node-2 ─┼─► Kafka → analysis-worker-pool (N개)
  streaming-node-N ─┘                └─► 결과 → MongoDB Atlas
```

---

### 6.7 로드맵 요약

```
2026-06-11 ─── M1 ─── MediaMTX 녹화 + MinIO 세그먼트 저장   (1~2주)
                         ↓ 영상 증거 보존 기능 확보
           ─── M2 ─── Playback API + 타임라인 UI             (1~2주)
                         ↓ 과거 영상 검색·재생 기능
           ─── M4 ─── RTCP 피드백 통계 + 품질 지표           (3~5일)
                         ↓ 스트림 품질 가시성 확보
           ─── M3 ─── Qdrant 벡터 DB + Re-ID 영속화          (2~3주)
                         ↓ 서버 재시작 후에도 Re-ID 연속
           ─── M5 ─── Kafka + 분산 클러스터                  (4~8주, 선택)
                         ↓ 카메라 50대+ 수평 확장
```

---

## 7. Acceptance Criteria

### 7.1 M1 — 영상 녹화 완료 기준

- [ ] MediaMTX `record: yes` 설정 후 카메라 시작 시 `/recordings/{camId}/` 디렉토리에 MP4 세그먼트 파일 생성됨
- [ ] 세그먼트 파일 크기 10~60 MB 이내 (30초 기준, 1080p H.264)
- [ ] MinIO/S3 업로드 완료 후 세그먼트 메타데이터가 DB에 저장됨 (camId, startTs, endTs, objectPath)
- [ ] 세그먼트 중 서버 재시작 발생 시 현재 세그먼트가 정상 종료되거나 재시작 후 이어쓰기 가능
- [ ] 로컬 디스크 정리 정책(보관 기간 초과 세그먼트 자동 삭제) 동작 확인

### 7.2 M2 — Playback API 완료 기준

- [ ] `GET /api/playback?cam={id}&ts={unix_ms}` 응답에 `videoUrl` 및 해당 구간 `events[]` 포함
- [ ] 반환된 videoUrl로 브라우저에서 영상 재생 가능 (HLS 또는 presigned MP4 URL)
- [ ] 타임라인 슬라이더에서 임의 시점 seek 동작 (< 3초 내 재생 시작)
- [ ] 알림 이벤트 마커 클릭 시 해당 시점 영상으로 이동
- [ ] 세그먼트 없는 시간 범위 요청 시 HTTP 404 응답

### 7.3 M3 — Qdrant Re-ID 완료 기준

- [ ] 서버 재시작 후에도 기존 등록 얼굴의 Re-ID 탐색 정상 동작
- [ ] 10,000개 임베딩 기준 탐색 레이턴시 < 50 ms
- [ ] 기존 `face_tracking.json` 임베딩 데이터 Qdrant로 마이그레이션 완료
- [ ] `POST /api/faces/search` 응답 구조 변경 없음 (하위 호환)

### 7.4 M4 — RTCP 피드백 처리 완료 기준

- [ ] `cameraStatus` Socket.IO 이벤트에 `rtcpStats.nackCount`, `rtcpStats.pliCount`, `rtcpStats.bytesReceived` 필드 포함
- [ ] 브라우저 화질 열화 시 PLI 카운트 증가 로그 출력
- [ ] RTCP 통계 폴링 간격 설정 가능 (기본값 5초, `RTCP_POLL_INTERVAL_MS` 환경변수)
- [ ] MediaMTX API 조회 실패 시 서버 전체에 영향 없음

### 7.5 M5 — 분산 클러스터 완료 기준

- [ ] 스트리밍 노드 2대 + 분석 노드 2대 구성에서 카메라 16대 동시 처리 성공
- [ ] 스트리밍 노드 1대 장애 시 해당 노드의 카메라가 다른 노드로 재배치됨
- [ ] Kafka consumer lag < 10초 (프레임 처리 지연)
- [ ] MongoDB Atlas 또는 복제셋에서 분석 결과 일관성 확인

---

## 8. Risk Assessment

| 리스크 | 가능성 | 영향 | 완화 방안 |
|---|---|---|---|
| MediaMTX 녹화 설정 버전 불일치 | 낮음 | 중간 | mediamtx.yml 버전 고정, 변경 시 API 버전 검증 |
| MinIO 디스크 용량 초과 | 중간 | 높음 | 보관 정책 자동 삭제, 용량 임계값 알림 구현 |
| Qdrant 컨테이너 재시작 시 인덱스 손실 | 낮음 | 높음 | 볼륨 마운트 설정 (`/qdrant/storage`), 백업 정책 수립 |
| face_tracking.json → Qdrant 마이그레이션 오류 | 중간 | 중간 | 마이그레이션 전 원본 백업, 롤백 스크립트 준비 |
| RTCP 통계 폴링으로 MediaMTX API 과부하 | 낮음 | 낮음 | 폴링 간격 5초 이상 유지, 오류 시 지수 백오프 |
| M5 Kafka 네트워크 레이턴시 증가 | 중간 | 중간 | 프레임 큐 크기 제한, consumer lag 모니터링 알림 |
| M2 Playback UI에서 seek 시 세그먼트 경계 처리 오류 | 중간 | 낮음 | 세그먼트 overlap 1~2초 설정 또는 HLS 사용 |
| ingest-daemon 재시작 시 일시적 프레임 손실 | 중간 | 낮음 | supervisor/pm2 자동 재시작, 재연결 로그 로테이션 |

---

## 9. Related Documents

| 문서 | 경로 | 관계 |
|---|---|---|
| RTSP → WebRTC 아키텍처 설계서 | [design/Design_RTSP_WebRTC_Architecture.md](../design/Design_RTSP_WebRTC_Architecture.md) | 아키텍처 구현 세부 설계 |
| Video Capture Pipeline 설계서 | [design/Design_Video_Capture_Pipeline.md](../design/Design_Video_Capture_Pipeline.md) | 캡처 백엔드 구현 상세 |
| RTSP Capture Backend 설계서 | [design/Design_RTSP_Capture_Backend.md](../design/Design_RTSP_Capture_Backend.md) | CAPTURE_BACKEND 별 상세 구현 |
| Video Capture Pipeline RFP | [rfp/RFP_Video_Capture_Pipeline.md](RFP_Video_Capture_Pipeline.md) | 캡처 파이프라인 기술 평가 |
| WebRTC Media Gateway RFP | [rfp/RFP_WebRTC_Media_Gateway.md](RFP_WebRTC_Media_Gateway.md) | WebRTC 미디어 게이트웨이 평가 |
| Server Architecture 설계서 | [design/Design_Server_Architecture.md](../design/Design_Server_Architecture.md) | SERVER_MODE 아키텍처 |
| STUN/TURN ICE 설계서 | [design/Design_STUN_TURN_ICE.md](../design/Design_STUN_TURN_ICE.md) | ICE 설정 세부 사항 |
| Distributed AI Pipeline RFP | [rfp/RFP_Distributed_AI_Pipeline.md](RFP_Distributed_AI_Pipeline.md) | M5 분산 클러스터 관련 |
| DB Layer 설계서 | [design/Design_DB_Layer.md](../design/Design_DB_Layer.md) | DB 스키마 및 확장 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 작성 |
