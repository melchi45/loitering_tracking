# PRD — RTSP·WebRTC Architecture (Ingest-Daemon + MediaMTX + 확장 Milestones)
**Document ID**: PRD-LTS-RWA-01  
**Version**: 1.0  
**Date**: 2026-06-11  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Approved  
**Parent RFP**: [rfp/RFP_RTSP_WebRTC_Architecture.md](../rfp/RFP_RTSP_WebRTC_Architecture.md)

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 작성 — ingest-daemon + MediaMTX WHEP 현재 구현 확정 및 M1-M5 마일스톤 정의 |

---

## Table of Contents

1. [Product Goal](#1-product-goal)
2. [Current Architecture Summary](#2-current-architecture-summary)
3. [Technology Selection](#3-technology-selection)
4. [Implementation Priorities](#4-implementation-priorities)
5. [Milestone M1 — 영상 녹화 (Video Recording)](#5-milestone-m1--영상-녹화-video-recording)
6. [Milestone M2 — Playback API](#6-milestone-m2--playback-api)
7. [Milestone M3 — Qdrant 벡터 DB Re-ID](#7-milestone-m3--qdrant-벡터-db-re-id)
8. [Milestone M4 — RTCP 피드백 처리](#8-milestone-m4--rtcp-피드백-처리)
9. [Milestone M5 — 분산 클러스터](#9-milestone-m5--분산-클러스터)
10. [Non-Functional Requirements](#10-non-functional-requirements)
11. [Compatibility & Rollback Policy](#11-compatibility--rollback-policy)
12. [Dependencies](#12-dependencies)

---

## 1. Product Goal

단일 RTSP 인제스트 파이프라인(ingest-daemon)과 MediaMTX WHEP WebRTC를 기반으로, 영상 녹화·재생·얼굴 Re-ID·RTCP 품질 피드백·분산 클러스터까지 확장 가능한 완전한 스트리밍 아키텍처를 구현한다.

**핵심 원칙**:
- 카메라당 RTSP 연결 **1개** — 단일 인제스트 프로세서(ingest-daemon)만 카메라에 접속
- **인프로세스 라이브러리 전용** — subprocess 직접 생성 금지 (ffmpeg 폴백 예외)
- **WHEP 표준** — SDP offer/answer 준수, 비표준 시그널링 금지
- 기능 추가 시 기존 캡처 파이프라인 변경 없이 서비스 레이어에서 확장

**성공 기준**:

| 마일스톤 | 성공 기준 |
|---|---|
| 현재 구현 | 카메라당 RTSP 연결 1개, WebRTC 연결 성공률 ≥ 99%, E2E 레이턴시 < 300 ms |
| M1 완료 | 카메라당 녹화 손실 0 프레임/분, MinIO 업로드 성공률 ≥ 99.9% |
| M2 완료 | Playback API 응답 < 200 ms, 세그먼트 정확도 ± 1 s |
| M3 완료 | Re-ID 정확도 ≥ 90%, Qdrant 쿼리 응답 < 50 ms |
| M4 완료 | RTCP NACK/PLI 요청 후 키프레임 수신 < 500 ms |
| M5 완료 | GPU 노드 100대 카메라 처리, 장애 노드 자동 페일오버 < 30 s |

---

## 2. Current Architecture Summary

### 2.1 핵심 컴포넌트

```
loitering_tracking/
├── ingest-daemon/
│   └── ingest_daemon.py           # Python PyAV 독립 캡처 데몬 (port 7070)
├── server/src/services/
│   ├── captureFactory.js          # CAPTURE_BACKEND 선택 팩토리
│   ├── ingestDaemonCapture.js     # ingest-daemon 수신 EventEmitter (권장)
│   ├── mediamtxManager.js         # MediaMTX 경로 등록/해제 (REST API :9997)
│   ├── pipelineManager.js         # AI 서비스 생명주기 오케스트레이터
│   └── faceService.js             # 얼굴 임베딩 Re-ID (현재 in-memory)
└── mediamtx.yml                   # MediaMTX 미디어 서버 설정
```

### 2.2 데이터 흐름

```
IP Camera (RTSP)
    │
    ▼ RTSP (단일 연결)
ingest_daemon.py (PyAV, :7070)
    │
    ├──▶ HTTP POST /api/ingest/frame/{camId}  ──▶  IngestDaemonCapture.injectFrame()
    │                                                    │
    │                                                    ▼
    │                                          pipelineManager → AI Pipeline
    │                                          (YOLO → ByteTrack → behaviorEngine)
    │
    └──▶ RTSP push → MediaMTX (:8554)
               │
               ▼
         MediaMTX WHEP (:8889/{camId}/whep)
               │
               ▼ WebRTC (WHEP 표준)
          Browser / Client
```

### 2.3 포트 구성

| 서비스 | 프로토콜 | 포트 | 용도 |
|---|---|---|---|
| Node.js HTTP | HTTP | 3080 | REST API, Socket.IO |
| Node.js HTTPS | HTTPS | 3443 | 보안 REST API |
| MediaMTX RTSP | RTSP/TCP | 8554 | 카메라 스트림 수신 |
| MediaMTX WHEP | HTTP | 8889 | WebRTC WHEP 엔드포인트 |
| MediaMTX ICE UDP | UDP | 8189 | WebRTC ICE 미디어 전송 |
| MediaMTX REST API | HTTP | 9997 | 경로 관리 API |
| ingest-daemon | HTTP | 7070 | 프레임 HTTP POST 수신 |

### 2.4 FORCE_NO_WEBRTC 조건

`CAPTURE_BACKEND === 'ingest-daemon' && WEBRTC_ENGINE === 'mediasoup'` 조합에서 WebRTC가 강제 비활성화된다. MediaMTX WHEP이 현재 권장 WebRTC 엔진이다.

### 2.5 captureFactory 폴백 순서

```
CAPTURE_BACKEND 환경변수
    ├── 'ingest-daemon' → IngestDaemonCapture  (권장, 현재 기본값)
    ├── 'gstreamer'     → GStreamerCapture
    ├── 'pyav'          → PyAVCapture
    └── 기타/미설정     → RTSPCapture (ffmpeg 레거시, 폴백)
```

---

## 3. Technology Selection

### 3.1 채택 기술 (현재 구현)

#### ingest-daemon (Python PyAV)
- **선택 이유**: 단일 RTSP 연결 원칙 준수, B-프레임 처리, Python ML 라이브러리 직접 연계
- **역할**: 카메라 → JPEG 프레임 추출 → Node.js HTTP POST + MediaMTX RTSP push
- **운영**: `npm run ingest:restart` 핫 재시작, 서버 전체 재시작 불필요

#### MediaMTX (WebRTC WHEP)
- **선택 이유**: WHEP 표준 준수, ICE/STUN/TURN 내장, 경로 단위 REST API 관리
- **역할**: RTSP 수신 → WebRTC WHEP 브라우저 직접 스트리밍
- **설정**: `mediamtx.yml` — `webrtcAddress`, `api: yes`, `apiAddress: :9997`

### 3.2 M1 — MinIO (영상 저장)
- **선택 이유**: S3 호환 API, 온프레미스 배포, mediamtx.yml `record: yes` 연동
- **대안 검토**: AWS S3 (클라우드 의존성), NFS (성능·확장성 한계)
- **결정**: MinIO 우선, AWS S3 설정도 동일 코드로 지원 (엔드포인트 교체)

### 3.3 M3 — Qdrant (벡터 Re-ID)
- **선택 이유**: REST API 기반, Docker 단일 컨테이너, 코사인 유사도 ANN 검색
- **대안 검토**: FAISS (인메모리 전용, 비영속적), Weaviate (무거운 스택), Pinecone (클라우드 전용)
- **결정**: Qdrant — 온프레미스 가능, REST API로 faceService.js 교체 용이

### 3.4 M5 — Kafka (분산 메시징)
- **선택 이유**: 스트림 파이프라인 기성 솔루션, 파티션 기반 카메라 분산, 컨슈머 그룹 자동 리밸런싱
- **대안 검토**: Redis Pub/Sub (지속성 없음), RabbitMQ (스트리밍 특화 아님)
- **결정**: Kafka — 분산 환경에서 카메라 스트림 확장성 최우선

---

## 4. Implementation Priorities

### 4.1 우선순위 결정 기준

| 기준 | 가중치 |
|---|---|
| 운영 즉시 필요성 (고객 요구) | 40% |
| 구현 복잡도 대비 효과 | 30% |
| 기존 아키텍처 의존성 | 30% |

### 4.2 마일스톤 우선순위

| 순위 | 마일스톤 | 우선도 | 선행 조건 | 이유 |
|---|---|---|---|---|
| 1 | **M1 — 영상 녹화** | P1 | 현재 구현 완료 | 법적 증거 보존, 보안 감시 핵심 요건, MediaMTX record 설정으로 구현 단순 |
| 2 | **M2 — Playback API** | P1 | M1 완료 | M1 없이 재생 불가, 녹화 데이터 활용 완성 |
| 3 | **M3 — Qdrant Re-ID** | P2 | 현재 구현 완료 | faceService 인메모리 한계 해소, 재시작 시 Re-ID 데이터 손실 방지 |
| 4 | **M4 — RTCP 피드백** | P2 | 현재 구현 완료 | 네트워크 품질 저하 대응, 영상 품질 자동 복구 |
| 5 | **M5 — 분산 클러스터** | P3 | M1, M2, M3 완료 | 100대+ 카메라 필요 시점에 구현, 현재 단일 서버로 20대 처리 충분 |

---

## 5. Milestone M1 — 영상 녹화 (Video Recording)

### 5.1 목표

카메라 스트림의 영상을 자동으로 녹화하여 로컬 또는 S3/MinIO 오브젝트 스토리지에 저장하고, 이후 재생·증거 보존·AI 재분석에 활용할 수 있도록 한다.

### 5.2 요구사항

#### 5.2.1 MediaMTX 녹화 설정
- `mediamtx.yml`에서 카메라 경로별 `record: yes` 활성화
- 세그먼트 단위: 기본 10분 (환경변수 `RECORD_SEGMENT_MINUTES`로 조정)
- 저장 형식: MP4 (H.264 + AAC)
- 파일명 패턴: `{camId}_{YYYY-MM-DD_HH-mm-ss}.mp4`

#### 5.2.2 recordingService.js 신규 서비스
- `pipelineManager.js`에 `recordingService` 등록 필수
- MediaMTX 녹화 완료 이벤트 수신 후 MinIO 업로드 트리거
- 업로드 실패 시 로컬 임시 경로 유지 + 재시도 큐(최대 3회)
- 카메라별 녹화 활성화 여부 런타임 제어: `POST /api/recording/:camId/start`, `POST /api/recording/:camId/stop`

#### 5.2.3 MinIO 연동
- S3 호환 SDK (`@aws-sdk/client-s3`) 사용
- 버킷 구조: `lts-recordings/{camId}/{date}/`
- 업로드 완료 후 로컬 임시 파일 자동 삭제
- Presigned URL 생성: 유효기간 기본 1시간 (환경변수 `RECORDING_PRESIGNED_TTL_SECONDS`)

#### 5.2.4 DB 기록
- `storage/lts.json` 또는 MongoDB `recordings` 컬렉션에 메타데이터 저장
- 메타데이터: `{ id, camId, startAt, endAt, duration, s3Key, size, status }`
- `GET /api/recordings` — 녹화 목록 조회 (query: camId, startDate, endDate, limit)

### 5.3 제외 범위
- 영상 트랜스코딩 (원본 MP4 그대로 저장)
- 클라이언트 녹화 재생 UI (M2에서 구현)

---

## 6. Milestone M2 — Playback API

### 6.1 목표

저장된 녹화 영상을 클라이언트에서 타임라인 기반으로 탐색하고 재생할 수 있는 API 및 UI를 제공한다.

### 6.2 API 명세

#### 6.2.1 세그먼트 목록 조회
```
GET /api/playback/segments?cam={camId}&startTs={unix}&endTs={unix}
```
- Response 200:
```json
{
  "segments": [
    {
      "id": "seg-001",
      "camId": "cam-01",
      "startTs": 1700000000,
      "endTs": 1700000600,
      "duration": 600,
      "url": "https://minio.host/lts-recordings/cam-01/2026-06-11/cam-01_2026-06-11_00-00-00.mp4"
    }
  ],
  "total": 144
}
```

#### 6.2.2 특정 시점 재생 URL
```
GET /api/playback?cam={camId}&ts={unixTimestamp}
```
- Response 200: `{ "url": "<presigned_url>", "startTs": ..., "seekOffset": 45 }`
- `seekOffset`: 세그먼트 내 오프셋(초), 클라이언트가 `video.currentTime = seekOffset` 설정

#### 6.2.3 이벤트 연동 재생
```
GET /api/playback/event/{alertId}
```
- 알림 발생 시각 ± 30초 세그먼트 URL 반환
- Response 200: `{ "url": "...", "seekOffset": ... }`

### 6.3 클라이언트 컴포넌트

- `PlaybackTimeline.tsx` — 타임라인 바, 세그먼트 색상 표시, 클릭 탐색
- `PlaybackPlayer.tsx` — `<video>` 태그 + seek, 알림 오버레이
- `CameraView.tsx` 상단 탭에 "Live" / "Playback" 전환 UI 추가

### 6.4 요구사항

- 세그먼트 간 연속 재생 지원 (현재 세그먼트 종료 전 다음 URL 프리패치)
- 재생 중 알림 오버레이 표시 (타임라인에서 알림 발생 시점 마커)
- 모바일 레이아웃 대응 (Tailwind 반응형)

---

## 7. Milestone M3 — Qdrant 벡터 DB Re-ID

### 7.1 목표

현재 `faceService.js`의 인메모리 얼굴 임베딩 저장소를 Qdrant 벡터 DB로 교체하여, 서버 재시작 후에도 Re-ID 데이터를 영속하고 ANN(Approximate Nearest Neighbor) 검색으로 성능을 개선한다.

### 7.2 요구사항

#### 7.2.1 Qdrant 컬렉션 설계
- 컬렉션명: `face_embeddings`
- 벡터 차원: 512 (ArcFace/InsightFace 기본값, 환경변수 `FACE_EMBEDDING_DIM`)
- 거리 메트릭: Cosine
- 페이로드: `{ personId, camId, registeredAt, name, thumbnailKey }`

#### 7.2.2 faceService.js 교체
- 기존 인메모리 Map → Qdrant REST API 클라이언트 (`qdrant-client` npm 패키지)
- `searchFace()`: Qdrant `/collections/face_embeddings/points/search` 호출, 유사도 임계값 `FACE_REID_THRESHOLD` (기본 0.75)
- 기존 `GET /api/faces`, `POST /api/faces/register`, `POST /api/faces/search` API 시그니처 유지

#### 7.2.3 데이터 마이그레이션
- 기존 `storage/face_tracking.json` 임베딩 데이터를 Qdrant로 일괄 임포트하는 마이그레이션 스크립트 제공
- 스크립트 경로: `server/src/scripts/migrateEmbeddingsToQdrant.js`

#### 7.2.4 폴백
- `REID_BACKEND=memory` 설정 시 기존 인메모리 방식으로 폴백 (레거시 호환)
- Qdrant 연결 실패 시 자동 폴백 + 경고 로그 출력

---

## 8. Milestone M4 — RTCP 피드백 처리

### 8.1 목표

WebRTC 스트림의 네트워크 품질 저하(패킷 손실, 지터)를 MediaMTX stats API로 감지하고, RTCP NACK/PLI/REMB 신호로 자동 품질 복구를 수행한다.

### 8.2 요구사항

#### 8.2.1 MediaMTX stats 폴링
- `mediamtxManager.js`에 stats 폴링 루프 추가: `GET /v3/paths/get/{id}`
- 폴링 주기: 5초 (`RTCP_STATS_INTERVAL_MS` 기본 5000)
- 모니터링 지표: `bytesReceived`, `bytesSent`, `framesDecoded`, `packetsLost`

#### 8.2.2 키프레임 요청 (PLI)
- `packetsLost` > 임계값(`RTCP_PLI_THRESHOLD` 기본 5%) 또는 `framesDecoded` 정체 감지 시
- MediaMTX REST API를 통해 PLI(Picture Loss Indication) 트리거: `POST /v3/paths/{id}/keyframeRequest`
- 연속 실패 3회 시 Socket.IO `cameraStatus` 이벤트로 클라이언트에 품질 저하 알림

#### 8.2.3 REMB 대역폭 조정
- RTT > 150 ms 감지 시 비트레이트 자동 하향 조정 (`RTCP_REMB_MIN_BITRATE` 기본 500 kbps)
- MediaMTX `maxVideoMbitps` 경로별 런타임 설정 업데이트

---

## 9. Milestone M5 — 분산 클러스터

### 9.1 목표

단일 서버 한계를 넘어 100대+ 카메라를 처리하기 위해 Kafka 메시지 버스 기반의 GPU 노드 풀과 로드 밸런서 아키텍처를 구현한다.

### 9.2 아키텍처 설계

```
[IP Cameras]
    │ RTSP
    ▼
[ingest-daemon 클러스터 (N개)]
    │ Kafka Producer (topic: raw-frames)
    ▼
[Kafka Broker 클러스터]
    │ Kafka Consumer (파티션 = 카메라 수)
    ▼
[GPU Analysis 노드 풀 (M개)]
    │ YOLO → ByteTrack → behaviorEngine
    │ Socket.IO / REST
    ▼
[Load Balancer (Nginx/HAProxy)]
    │
    ▼
[Browser Clients]
```

### 9.3 요구사항

#### 9.3.1 Kafka 연동
- `server/src/services/kafkaFrameProducer.js` — 프레임을 Kafka `raw-frames` 토픽으로 발행
- `server/src/services/kafkaFrameConsumer.js` — GPU 노드에서 프레임 소비 + AI 추론
- 파티션 키: `camId` (동일 카메라 프레임은 항상 같은 파티션)
- 컨슈머 그룹: `lts-analysis-workers`

#### 9.3.2 GPU 노드 풀 관리
- `server/src/services/nodePoolManager.js` — 노드 등록/해제, 헬스체크
- 노드 장애 감지 (헬스체크 3회 실패) → Kafka 파티션 리밸런싱 자동 트리거
- 페일오버 시간 목표: < 30초

#### 9.3.3 로드 밸런서
- WebRTC 세션은 sticky session (카메라 → 특정 MediaMTX 노드 고정)
- REST API 요청은 라운드 로빈

#### 9.3.4 모니터링
- `GET /api/cluster/status` — 노드 풀 상태, 카메라별 할당 정보
- Prometheus 메트릭 엔드포인트: `/metrics`

---

## 10. Non-Functional Requirements

### 10.1 성능

| 항목 | 요구사항 |
|---|---|
| E2E 레이턴시 (카메라 → 브라우저) | < 300 ms (로컬 네트워크 기준) |
| WebRTC 연결 수립 시간 | < 3초 (ICE gathering 포함) |
| 동시 처리 카메라 수 (단일 서버) | ≥ 20대 (8코어 CPU) |
| 동시 처리 카메라 수 (M5 클러스터) | ≥ 100대 |
| Playback API 응답 시간 | < 200 ms |
| Qdrant Re-ID 쿼리 응답 | < 50 ms |

### 10.2 가용성

| 항목 | 요구사항 |
|---|---|
| 시스템 가용성 | ≥ 99.5% (월간 기준, 계획된 유지보수 제외) |
| ingest-daemon 재시작 시 스트림 복구 | < 10초 |
| MediaMTX 경로 재등록 | 서버 시작 후 자동, < 5초 |
| M5 노드 장애 페일오버 | < 30초 |

### 10.3 보안

- RTSP URL 자격증명 로그 출력 금지
- MinIO/S3 Presigned URL 유효기간 최대 24시간
- Qdrant API 키 환경변수(`QDRANT_API_KEY`) 관리, 하드코딩 금지
- 녹화 파일 접근은 JWT 인증 필수

### 10.4 확장성

- 신규 캡처 백엔드 추가 시 `captureFactory.js` 분기만 수정 (인터페이스 불변)
- 신규 AI 서비스 추가 시 `pipelineManager.js` 등록만으로 파이프라인 편입

---

## 11. Compatibility & Rollback Policy

### 11.1 하위 호환성

| 변경 사항 | 하위 호환 여부 | 비고 |
|---|---|---|
| M1 recordingService 추가 | 호환 | `RECORDING_ENABLED=false` 시 비활성 |
| M2 Playback API 추가 | 호환 | 신규 엔드포인트, 기존 API 변경 없음 |
| M3 Qdrant Re-ID 전환 | 조건부 호환 | `REID_BACKEND=memory` 폴백 지원 |
| M4 RTCP 폴링 추가 | 호환 | `RTCP_STATS_ENABLED=false` 시 비활성 |
| M5 Kafka 분산 전환 | 비호환 | 별도 배포 단계 필요, 단일 서버 모드 유지 가능 |

### 11.2 롤백 절차

```bash
# M1 롤백: recordingService 비활성화
RECORDING_ENABLED=false npm run dev

# M3 롤백: Qdrant → 인메모리 폴백
REID_BACKEND=memory npm run dev

# M5 롤백: Kafka 비활성화, 단일 서버 모드
KAFKA_ENABLED=false npm run dev
```

### 11.3 데이터 마이그레이션 롤백

- M3 Qdrant 마이그레이션 전 `storage/face_tracking.json` 백업 필수
- `server/src/scripts/rollbackEmbeddingsFromQdrant.js` 제공 예정

---

## 12. Dependencies

### 12.1 런타임 의존성

| 컴포넌트 | 버전 요구사항 | 설치 방법 |
|---|---|---|
| Node.js | ≥ 18.0.0 | apt / nvm |
| Python | ≥ 3.9 | apt / pyenv |
| MediaMTX | ≥ 0.23.0 | GitHub Release 바이너리 |
| ingest-daemon (PyAV) | PyAV ≥ 11.0 | `pip install av` |
| MinIO Client (M1) | `@aws-sdk/client-s3` ≥ 3.x | `npm install` |
| Qdrant (M3) | ≥ 1.7.0 | Docker |
| `qdrant-client` npm (M3) | ≥ 1.7.0 | `npm install qdrant-client` |
| Kafka (M5) | ≥ 3.5.0 | Docker / Confluent |
| `kafkajs` (M5) | ≥ 2.x | `npm install kafkajs` |

### 12.2 외부 서비스 의존성

| 서비스 | 목적 | 필수 여부 |
|---|---|---|
| MinIO / AWS S3 | 녹화 영상 저장 (M1) | M1 이상 필수 |
| Qdrant | 얼굴 임베딩 영속 (M3) | M3 이상 필수, 폴백 있음 |
| Kafka | 분산 프레임 메시징 (M5) | M5 필수 |
| STUN/TURN 서버 | WebRTC ICE | 외부 네트워크 시 필수 |

### 12.3 관련 문서

- [Design_RTSP_WebRTC_Architecture.md](../design/Design_RTSP_WebRTC_Architecture.md)
- [SRS_RTSP_WebRTC_Architecture.md](../srs/SRS_RTSP_WebRTC_Architecture.md)
- [OPS_RTSP_WebRTC_Architecture_Setup.md](../ops/RTSP_WebRTC_Architecture_Setup.md)
- [PRD_Video_Capture_Pipeline.md](PRD_Video_Capture_Pipeline.md)
- [PRD_WebRTC_Media_Gateway.md](PRD_WebRTC_Media_Gateway.md)
- [PRD_Storage_MongoDB.md](PRD_Storage_MongoDB.md)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 작성 — ingest-daemon + MediaMTX 현재 구현 확정, M1-M5 마일스톤 정의 |
