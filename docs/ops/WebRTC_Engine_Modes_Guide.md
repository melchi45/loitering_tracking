# Operations Guide
# WebRTC Engine Modes 운영 가이드 (mediamtx / mediasoup)

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-WEM-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-07-23 |
| **Status** | **Active** |
| **Related MRD** | [mrd/MRD_WebRTC_Engine_Modes.md](../mrd/MRD_WebRTC_Engine_Modes.md) |
| **Related PRD** | [prd/PRD_WebRTC_Engine_Modes.md](../prd/PRD_WebRTC_Engine_Modes.md) |
| **Related SRS** | [srs/SRS_WebRTC_Engine_Modes.md](../srs/SRS_WebRTC_Engine_Modes.md) |
| **Related Design** | [design/Design_WebRTC_Engine_Modes.md](../design/Design_WebRTC_Engine_Modes.md) |

---

## 1. 요약 — 지금 무엇을 쓰고 있는가

```bash
grep WEBRTC_ENGINE server/.env
# WEBRTC_ENGINE=mediamtx   ← 이 저장소의 현재 기본값·활성 엔진
```

`WEBRTC_ENGINE=mediamtx`가 현재 이 프로젝트의 표준 설정이다. `mediasoup` 코드는 저장소에 완전히 남아있지만 이 설정에서는 **전혀 실행되지 않는다(dormant)**. mediasoup으로 전환한 과거 운영에서 영상 끊김/재생 불가가 반복 관측되어 mediamtx로 되돌린 이력이 있다 — 특별한 이유(§4 전환 판단 기준) 없이 mediasoup으로 되돌리지 말 것.

---

## 2. 빠른 비교표

| 항목 | mediamtx (기본) | mediasoup (dormant) |
|---|---|---|
| 카메라 RTSP 접속 주체 | MediaMTX 프로세스 | ingest-daemon |
| 브라우저 재생 경로 | 브라우저 ↔ MediaMTX 직접 UDP | 브라우저 ↔ mediasoup Worker 직접 UDP |
| App RTP(ONVIF) 전달 | Socket.IO만 | Socket.IO + DataChannel |
| H.265/HEVC 카메라 | 재생 가능 | **재생 불가** (mediasoup 자체 제약) |
| 장애 시 복구 단위 | MediaMTX 프로세스 재시작 | 죽은 mediasoup Worker에 배정된 카메라만 재등록 |
| 실측 안정성(이 배포) | 양호 | 끊김/재생 불가 반복 |
| 필수 외부 프로세스 | MediaMTX 바이너리 (`MEDIAMTX_BIN`) | 없음 (Node 내장) — 단, Linux 공유 호스트에서는 `mediasoup-worker-priority-wrapper` 빌드 권장 |

상세 아키텍처/코드 경로는 [Design_WebRTC_Engine_Modes.md](../design/Design_WebRTC_Engine_Modes.md) 참조.

---

## 3. 엔진 전환 절차

```bash
# 1. server/.env 수정
vi server/.env
# WEBRTC_ENGINE=mediamtx  →  WEBRTC_ENGINE=mediasoup   (또는 반대)

# 2. 서버 재시작 (SERVER_MODE에 맞게)
cd server
npm run stop && npm run start           # combined
npm run stop:streaming && npm run streaming   # streaming

# 3. 확인
curl -s http://localhost:3080/api/webrtc/ice-test -X POST | jq .engine
#   mediamtx  → "mediamtx-whep"
#   mediasoup → "mediasoup"
```

**주의**: 전환 시 기존에 연결되어 있던 모든 WebRTC 세션이 끊긴다 — 브라우저 새로고침이 필요하다. 무중단 전환은 지원하지 않는다.

---

## 4. 전환 판단 기준

### 4.1 mediamtx를 유지해야 하는 경우 (기본, 대부분의 사이트)

- 특별한 제약이 없는 일반적인 배포
- H.265/HEVC 카메라가 하나라도 포함된 fleet
- 운영 복잡도를 낮게 유지하고 싶은 경우

### 4.2 mediasoup 재검토를 고려할 수 있는 경우 (드묾, 사전 검증 필수)

- 카메라의 동시 RTSP 세션 제한이 매우 엄격(1개만 허용)하여, MediaMTX + ingest-daemon 이중 재접속조차 문제가 되는 특수 카메라
- WebRTC DataChannel을 통한 저지연 App RTP(ONVIF) 전달이 필수인 사이트

→ 이 경우에도 **먼저 fleet에 H.265 카메라가 없는지 확인**하고(§2), 재전환 후 최소 1주일 이상 "영상 끊김" 발생 여부를 Admin Dashboard 로그로 모니터링할 것.

---

## 5. 문제 해결

### 5.1 "영상이 끊기고 잘 안 보임" (mediasoup 모드)

| 원인 후보 | 진단 | 조치 |
|---|---|---|
| 브라우저별 H.264 PT 불일치 | `GET /api/client-logs/webrtc` 응답에서 `inbound-rtp` 항목 부재 + `candidate-pair.bytesReceived > 0` | Design §4.6a alt-PT 캐시가 자동 처리하지만, 신규 브라우저/OS 조합에서 최초 1회는 지연 발생 가능 |
| H.265 카메라 | 서버 로그에 `mediasoup has no H.265 support` 경고 | mediamtx로 전환하거나 카메라를 H.264로 재설정 |
| mediasoup Worker 스케줄링 지연 (공유 호스트) | `/proc/net/snmp`의 `Udp.RcvbufErrors` 증가, Worker CPU는 낮음 | `npm run build:mediasoup-wrapper`로 우선순위 wrapper 빌드 (Linux 전용) — [Design_Mediasoup_Multi_Worker.md](../design/Design_Mediasoup_Multi_Worker.md) §7 |
| **근본 대응** | 위 조치로도 해결되지 않으면 | **mediamtx로 되돌린다** — 이 프로젝트의 실측 결론(§9 Design 문서) |

### 5.2 mediamtx 모드에서 카메라가 재생되지 않음

| 원인 후보 | 진단 | 조치 |
|---|---|---|
| MediaMTX 프로세스 미기동 | `ps aux \| grep mediamtx`, `curl http://127.0.0.1:9997/v3/config/global/get` | `startServer.js`가 자동 기동하는지 확인, `MEDIAMTX_BIN` 경로 확인 |
| MediaMTX 경로 등록 실패 | 서버 로그 `MediaMTX path registration failed` | 카메라 RTSP URL/자격증명 확인, MediaMTX API(`:9997`) 접근 가능 여부 확인 |
| WHEP 프록시 실패 | `POST /api/webrtc/whep/:cameraId`가 503 | `POST /api/webrtc/ice-test`로 엔진 헬스 확인 |

### 5.3 공통 진단 명령

```bash
# 현재 활성 엔진과 헬스 확인
curl -s -X POST http://localhost:3080/api/webrtc/ice-test | jq .

# (dev 환경 또는 서버 로컬에서만) 파이프라인 상세 모니터
curl -s http://localhost:3080/api/webrtc/monitor | jq .

# mediamtx 프로세스/포트 확인
ss -tlnp | grep -E '8554|8889|8189|9997'

# mediasoup 관련 UDP 포트 확인 (mediasoup 모드일 때만)
ss -ulnp | grep -E '4[0-9]{4}'
```

---

## 6. 관련 환경변수

| 변수 | 적용 엔진 | 기본값 | 설명 |
|---|---|---|---|
| `WEBRTC_ENGINE` | 공통 | `mediamtx` | `mediamtx`\|`mediasoup`\|`werift` |
| `MEDIAMTX_BIN` / `MEDIAMTX_BIN_LINUX` / `MEDIAMTX_BIN_WINDOWS` | mediamtx | - | MediaMTX 바이너리 경로 |
| `MEDIAMTX_RTSP_PORT` | mediamtx | 8554 | 로컬 루프백 RTSP 포트 |
| `MEDIAMTX_WEBRTC_URL` | mediamtx | `http://127.0.0.1:8889` | WHEP 엔드포인트 |
| `MEDIASOUP_NUM_WORKERS` | mediasoup | `min(cpuCount, 8)` | Worker Pool 크기 |
| `MEDIASOUP_WORKER_PRIORITY` | mediasoup | `-5` | Worker 프로세스 `nice` 값 |
| `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT` | mediasoup | 40000 / 49999 | ICE/RTP UDP 포트 범위 |
| `SERVER_IP` / `SERVER_PUBLIC_IP` | mediasoup | - | ICE candidate에 announce할 IP (필수급 — 미설정 시 ICE 실패 가능) |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 — mediamtx/mediasoup 전환 절차, 판단 기준, 문제 해결 가이드 |
