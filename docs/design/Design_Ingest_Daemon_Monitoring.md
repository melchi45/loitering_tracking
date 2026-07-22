# DESIGN DOCUMENT
# Ingest Daemon Real-Time Monitoring — Admin Dashboard

| | |
|---|---|
| **Document ID** | DESIGN-INGEST-MONITOR-001 |
| **Version** | 2.0 |
| **Status** | Implemented — verified live end-to-end (§8) |
| **Date** | 2026-07-21 |
| **Related Design** | [Design_RTSP_Capture_Backend.md](Design_RTSP_Capture_Backend.md) §6.29 (ingest-daemon reliability findings this doc builds on) |

---

## 1. Requirement

Admin 계정으로 로그인한 사용자가 Admin Dashboard에서 ingest-daemon의 상태를 실시간으로 모니터링할 수 있어야 한다. 요청된 항목:

1. 현재 연결된 채널 및 카메라 정보
2. RTSP 및 YouTube URL 정보
3. 현재 수신받는 Bps, Fps, Audio/Video codec 정보
4. IP 연결 정보
5. 현재 Capture 되는 실시간 정보
6. Analysis Server로 전송되는 영상 정보
7. 분석 서버로부터 수신 받는 분석 정보
8. Streaming Server로 전송되는 정보
9. (기타 추가 가능한 정보 — 발견 시 사용자에게 확인)

추가 요청: Streaming Dashboard 하단의 Ingest-Daemon 상태 배지(`SystemStatusBadges.tsx`, 2026-07-21 추가)를 Admin 계정으로 클릭하면 Admin Dashboard의 신규 Ingest Daemon 패널로 이동.

---

## 2. 현재 상태 조사 결과 — ingest_daemon.py가 실제로 노출하는 정보

`ingest-daemon/ingest_daemon.py`의 HTTP API(`Handler` 클래스, `BaseHTTPRequestHandler` 기반 — 프레임워크 없는 raw 구현)는 현재 다음만 제공한다:

| 메서드 | 경로 | 반환 정보 |
|---|---|---|
| GET | `/health` | `{status, cameras: <count>}` — 카메라 "개수"만, 목록·상세 없음 |
| GET | `/cameras` | `{count: <int>}` — 위와 동일한 개수만 |
| GET | `/cameras/:id/video-params` | codec 이름, sprop-parameter-sets, profile-level-id(H.264/H.265) — **SDP 협상용으로만 존재**, 실시간 통계 아님 |
| POST | `/cameras` | 카메라 등록 (RTSP URL·콜백 URL·mediasoup 포트 등 입력만, 조회 API 아님) |
| POST | `/cameras/:id/video-fanout` | 비디오 RTP fan-out 대상 포트 추가 |
| DELETE | `/cameras/:id` | 카메라 제거 |

`CameraSession`(카메라당 인스턴스) 내부 상태를 확인한 결과, **요청하신 항목 대부분에 해당하는 실시간 카운터가 현재 전혀 존재하지 않는다**:

- bps/fps 카운터 없음 (video/audio/AI-JPEG 어느 것도)
- 카메라 연결 IP/포트, 연결 상태(connected/reconnecting/failed) 추적 없음
- 실제 협상된 코덱 상세(H.264 profile 외 해상도·비트레이트 등) 없음
- fan-out 대상별(mediasoup RTP, Node AI 콜백, App RTP) 마지막 전송 시각·바이트 수 없음

즉 이번 기능은 Node 쪽 프록시/집계만으로 끝나지 않고, **`ingest_daemon.py` 자체에 실시간 통계 수집 로직을 새로 추가**해야 하는 범위다.

---

## 3. 요청 항목별 데이터 출처 매핑

사용자가 "ingest daemon의 모든 정보"로 요청한 항목 중 일부는 아키텍처상 ingest-daemon(Python)이 아니라 Node 서버(streaming) 쪽에 이미 존재하거나 존재해야 하는 정보다. 이 구분이 설계에 중요해 표로 정리한다.

| # | 요청 항목 | 실제 데이터 출처 | 현재 상태 |
|---|---|---|---|
| 1 | 연결된 채널/카메라 정보 | Node DB(`cameras` 테이블) — 이름·타입 등 메타 / ingest-daemon — 실제 연결 여부 | DB는 존재, ingest-daemon 쪽 연결 상태 추적 신규 필요 |
| 2 | RTSP/YouTube URL | Node DB(`cameras.rtspUrl`, YouTube는 `youtubeStreamService` 내부) | 이미 존재 — 조회만 하면 됨 |
| 3 | 수신 Bps/Fps/codec | **ingest-daemon** — RTSP 수신 관점의 실측치 | 신규 계측 필요 |
| 4 | IP 연결 정보 | **ingest-daemon** — 카메라와의 실제 소켓 연결 정보 | 신규 계측 필요 |
| 5 | 실시간 Capture 정보 | **ingest-daemon** — 프레임 도착 간격, 마지막 프레임 시각 등 | 일부(video-params 트리거 시점)만 간접적으로 존재, 신규 계측 필요 |
| 6 | Analysis Server로 전송되는 영상 정보 | **Node 서버**(streaming 모드) — `analysisClient.js`가 ingest-daemon으로부터 받은 JPEG를 원격 Analysis 서버로 전달. **ingest-daemon은 이 전송에 관여하지 않음** | Node 쪽에 부분적으로 존재(`pipelineManager` ctx의 `framesProcessed`/`bytesReceivedTotal` 등) |
| 7 | 분석 서버로부터 수신하는 분석 정보 | **Node 서버** — Analysis 서버 응답(detections/tracked/behaviors)을 받는 지점. ingest-daemon과 무관 | 부분 존재 — `pipelineManager` ctx의 `detectionsTotal`/`trackedTotal`/`facesTotal`/`fireSmokeTotal`/`loiteringTotal`, `getAnalysisClientStats()`(회로차단기 상태: total/errors/dropped/inflight) |
| 8 | Streaming Server로 전송되는 정보 | **ingest-daemon → Node**: AI JPEG(`callbackUrl`) + mediasoup RTP(video/audio UDP) + App RTP(ONVIF). 후자 두 개는 이미 부분적으로 Node 쪽에서 계측됨(`/api/webrtc/monitor`의 `producerStats.videoBytesRx`/`audioBytesRx`) | AI JPEG 경로는 Node `pipelineManager` ctx(`frameCount`, `bytesReceivedTotal`)로 존재. RTP 경로는 이미 존재하는 `getProducerStats()` 재사용 가능 |

**결론**: "Ingest Daemon" 화면이지만 실제로는 카메라별 전체 파이프라인(캡처→AI 전달→분석 왕복→WebRTC 전달)을 한 화면에 모으는 형태가 된다. §7에서 이 범위를 사용자에게 확인 요청.

---

## 4. 제안 아키텍처

```
┌─────────────────┐   신규 실시간 통계 수집    ┌──────────────────────┐
│ ingest_daemon.py │───────────────────────────▶│ GET /cameras/stats   │ (신규)
│ (CameraSession)  │   (bps/fps/IP/연결상태)     │ 전체 카메라 통계 배열  │
└─────────────────┘                             └──────────────────────┘
                                                            │
                                                            │ 폴링 (2~3s)
                                                            ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Node 서버 (streaming/combined)                                         │
│  GET /admin/ingest-daemon  (신규, admin 전용)                          │
│   = ingest-daemon 신규 통계                                            │
│   + DB cameras 테이블(이름/RTSP·YouTube URL/타입)                       │
│   + pipelineManager ctx(AI 프레임/분석 결과 누적치) — 이미 존재          │
│   + getAnalysisClientStats()(Analysis 서버 회로차단기) — 이미 존재      │
│   + getProducerStats()(mediasoup RTP 수신량) — 이미 존재                │
└───────────────────────────────────────────────────────────────────────┘
                                                            │
                                                            │ 폴링 (2~3s, AdminUsersPage.tsx의
                                                            │ SystemSection과 동일 패턴)
                                                            ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Admin Dashboard — 신규 "Ingest Daemon" 섹션 (AdminUsersPage.tsx)        │
│  카메라별 카드/테이블: 연결상태 · URL · Bps/Fps/Codec · IP ·             │
│  Capture 상태 · →Analysis 전송량 · ←Analysis 수신 결과 · →Streaming 전송량 │
└───────────────────────────────────────────────────────────────────────┘
```

**갱신 방식**: 기존 Admin Dashboard `SystemSection`의 REST 폴링(3초) 패턴을 그대로 따른다 — 이 프로젝트에 Admin 실시간 화면용 Socket.IO 채널이 없고(다른 화면은 REST 폴링만 사용), 새로 도입하기보다 기존 컨벤션 유지가 일관적이다. Socket.IO push를 원하시면 §7에서 확인 요청.

**클릭 이동**: `SystemStatusBadges.tsx`의 Ingest-Daemon 배지 — 로그인 사용자가 admin 역할일 때만 `<Link>`/`onClick` 네비게이션 활성화, `/admin`으로 이동 + `AdminSection`을 `'ingest'`(신규)로 사전 선택. 비-admin 사용자에게는 현재처럼 정적 표시만 유지.

---

## 5. ingest_daemon.py 신규 계측 항목 (Python 측)

`CameraSession`에 추가 예정 (실제 필드명은 구현 시 코드 컨벤션에 맞춰 조정):

- `connected_at` / `last_packet_at` — 연결·최근 패킷 수신 시각
- `peer_ip` / `peer_port` — RTSP 소켓의 실제 연결 대상
- 초 단위 롤링 카운터: video bytes/sec, audio bytes/sec, video fps, audio fps, AI-JPEG fps
- `connection_state` — `connecting | connected | reconnecting | failed`
- fan-out 대상별(mediasoup video/audio, Node AI 콜백, App RTP) 마지막 성공 전송 시각

신규 엔드포인트 후보: `GET /cameras/stats` (전체 배열, 대시보드 폴링용) — 기존 `GET /cameras/:id/video-params`처럼 카메라별 조회도 유지할지는 §7에서 확인.

---

## 6. Node 서버 / 클라이언트 신규 항목

- `server/src/routes/admin.js`에 `GET /admin/ingest-daemon` 추가 (기존 `router.use(verifyAccessToken); router.use(requireRole('admin'))`이 이미 라우터 레벨에 걸려 있어 별도 인증 코드 불필요).
- `AdminUsersPage.tsx`의 `AdminSection` 유니온에 `'ingest'` 추가, 사이드바 항목 추가, `IngestDaemonSection` 컴포넌트 신규 작성(SystemSection과 동일한 `useCallback`+`setInterval(3000)` 패턴).
- `SystemStatusBadges.tsx`에 admin 역할 판별(기존 `useAuthStore` 활용) + 클릭 네비게이션 추가.

---

## 7. 결정 사항 (2026-07-21 확정)

| # | 질문 | 결정 |
|---|---|---|
| 1 | 범위 | **전체 파이프라인 통합** — ingest-daemon 실측치 + 기존 Node 쪽 Analysis 왕복 통계·mediasoup 수신 통계까지 한 화면에 통합 표시 |
| 2 | 갱신 방식 | **Socket.IO 실시간 push** — REST 폴링이 아닌 신규 소켓 채널 |
| 3 | IP 연결 정보 | **표시함** — 연결 상태(connecting/connected/reconnecting/failed)와 함께 실제 소켓 IP/포트 노출 |
| 4 | YouTube 채널 표시 | (간이 확인, 별도 질의 없이 진행) 원본 YouTube URL + `yt-dlp`/`ffmpeg` 파이프라인 상태로 표시 — 다르면 사용자 피드백으로 조정 |
| 5 | 이력/그래프 | **포함** — 최근 수 분간 Bps/Fps 시계열 미니 그래프(WebRtcStatsPanel과 유사한 형태) |

이 결정에 따라 §4의 아키텍처를 갱신한다: REST 폴링 대신 신규 Socket.IO 채널(`admin:ingest-stats` 가칭)을 사용하고, 클라이언트는 최근 N개 샘플을 프론트엔드 메모리에 롤링 버퍼로 유지해 그래프를 그린다(서버가 시계열을 영속화하지 않음 — WebRTC ICE 패널의 `rxHistory` 패턴과 동일).

### 갱신된 아키텍처

```
ingest_daemon.py (CameraSession)
  └─ 1초 주기 자체 통계 계산(bps/fps/연결상태) → 신규 GET /cameras/stats (Node가 폴링)
        Node 서버가 Socket.IO push의 소스 데이터로 사용 — ingest-daemon 자체에 Socket.IO를
        새로 붙이지 않고(불필요한 복잡도), 기존처럼 Node가 HTTP로 당겨온 뒤 재가공해 push한다.
              │
              ▼
Node 서버 — 신규 주기 타이머(예: 1~2초)가 GET /cameras/stats 결과 + DB(cameras 테이블) +
pipelineManager ctx(AI/분석 누적치) + getAnalysisClientStats() + getProducerStats()를 합쳐
Socket.IO로 admin 세션에게 push (신규 이벤트, 예: `admin:ingest-stats`)
              │
              ▼
Admin Dashboard 신규 'ingest' 섹션 — 소켓 구독, 카메라별 카드 + 최근 N분 Bps/Fps 미니 그래프
(롤링 버퍼는 클라이언트 메모리에만 유지, 서버는 영속화하지 않음)
```

---

## 8. 구현 결과 (2026-07-21)

### 8.1 ingest_daemon.py

- `CameraStats`(dataclass) 신규 — `connection_state`/`peer_ip`/`peer_port`/`connected_at`/`last_*_at`/`video_width`/`video_height` + 누적 카운터(`video_bytes_total` 등) + 계산된 rate(`video_bps`/`video_fps`/`audio_bps`/`audio_fps`/`ai_fps`). `CameraSession.stats`로 보유.
- Hot path(`_combined_ingest_once`의 데먹스 루프)에는 단순 `+=` 누적만 추가 — 락 없음(필드별 단일 라이터, CPython GIL로 충분), 함수 호출 오버헤드 없음.
- `_resolve_rtsp_peer()` — RTSP URL 호스트를 `socket.gethostbyname()`으로 해석해 `peer_ip`/`peer_port` 채움(PyAV가 실제 TCP 소켓의 peer 주소를 노출하지 않아 독립 해석; URL이 이미 IP 리터럴인 경우가 대부분이라 실용적으로 충분).
- `_stats_sampler()` — 모듈 전역 백그라운드 스레드 1개(카메라당 스레드 아님), 1초마다 모든 `CameraSession`의 누적 카운터를 diff해 bps/fps 계산. hot path와 완전히 분리.
- `GET /cameras/stats` 신규 — 전체 카메라의 `stats_dict()`(정체성 + 실시간 통계) 배열 반환.
- **실측 검증**: 재시작 후 실제 카메라(TNM-C2712TDR, 2048×1536 HEVC)에서 `videoBps≈3.8Mbps`, `videoFps≈30`, `connectionState:"connected"`, `peerIp:"192.168.214.39"` 등 정확한 라이브 값 확인.

### 8.2 Node 서버

- `server/src/services/ingestStatsAggregator.js` 신규 — `CAPTURE_BACKEND=ingest-daemon`일 때만 기동(`index.js`). 1.5초 주기 타이머가 `GET /cameras/stats` + `db.all('cameras')` + `pipelineManager.getIngestMonitorStats()`(신규 메서드, §3 표의 6/7 항목) + `pipelineManager.getAnalysisClientStats()` + `getWebRTCEngine().getProducerStats()`(§3 표의 8 항목, mediasoup 수신량)를 병합해 페이로드 구성. **구독자가 없으면 폴링 자체를 건너뛴다**(불필요한 부하 방지).
- **보안**: 이 코드베이스의 기존 Admin 전용 Socket.IO 이벤트(`server:log`/`admin:subscribe-logs`, `utils/logger.js`)는 서버 측 권한 검증이 전혀 없이 `io.emit()`으로 전체 브로드캐스트하고 있음을 발견 — RTSP URL이 카메라 자격증명을 포함하므로 신규 기능은 이 선례를 따르지 않기로 결정. `middleware/auth.js`에 `verifySocketAdmin(token)` 신규 추가(기존 JWT 검증 로직 재사용, `verifyToken()`으로 추출), `admin:subscribe-ingest-stats` 이벤트가 토큰을 받아 검증 후에만 소켓을 구독자 Set에 추가 — 페이로드는 `io.to(socketId).emit()`으로 검증된 소켓에만 개별 전송(`io.emit()` 아님).
- **실측 검증**: RS256로 서명한 테스트 토큰으로 admin/viewer 역할 각각 테스트 — admin 토큰은 정상적으로 실시간 데이터 수신, viewer(비-admin) 토큰은 6초 내 아무 데이터도 수신하지 못함(의도된 거부) 확인.

### 8.3 클라이언트

- `client/src/components/IngestDaemonSection.tsx` 신규 — `admin:subscribe-ingest-stats`(mount 시 accessToken과 함께) / `admin:unsubscribe-ingest-stats`(unmount 시) 구독, 카메라별 카드 UI(연결상태·URL·IP·codec·해상도·Bps/Fps·AI fps·Analysis 왕복 카운터·mediasoup 수신량). Bps/Fps는 서버가 스냅샷만 보내므로 클라이언트 자체 롤링 버퍼(최대 60개 샘플, `useWebRTC.ts`의 `rxHistory` 패턴과 동일)로 시계열 누적 후 Sparkline 렌더.
- `client/src/components/Sparkline.tsx` 신규 — `WebRtcStatsPanel.tsx`에 있던 미니 그래프 컴포넌트를 추출해 공유(중복 제거).
- `AdminUsersPage.tsx` — `AdminSection`에 `'ingest'` 추가, 사이드바 항목 추가(`isAnalysis`일 때 숨김 — `webrtc`와 동일 조건), 렌더 분기 추가.
- `authStore.ts`에 `pendingAdminSection` 신규 필드 — `SystemStatusBadges.tsx`의 Ingest-Daemon 배지를 admin 사용자가 클릭하면 `setPendingAdminSection('ingest')` 후 `navigateTo('admin')`, `AdminUsersPage` mount 시 1회 소비 후 클리어.
- `npx tsc --noEmit` / `npm run build` 클린 통과.

### 8.4 미해결/후속 과제

- YouTube 채널 표시(§7 결정 #4)는 확인 질의 없이 진행한 가정 — 사용자 피드백 대기.
- `db.all('cameras')`를 1.5초마다 동기 호출 — `MongoDatabase`는 in-memory mirror 읽기라 저렴하지만, 카메라 수가 매우 많아지면 이 폴링 비용을 재검토할 필요가 있음.
- 원격 Analysis 서버(192.168.214.254) 자체의 지표는 이번 범위에 포함하지 않음(스트리밍 서버 관점의 회로차단기 통계만) — 필요 시 별도 논의.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 2.0 | 2026-07-21 | §8 구현 결과 추가 — Python 계측, Node 집계/Socket.IO(admin 검증 포함), 클라이언트 UI 전부 구현 완료 및 실측 검증(실 카메라 데이터, admin/viewer 권한 분리 확인) |
| 1.0 | 2026-07-21 | §7 결정 사항 확정(전체 파이프라인 통합/Socket.IO push/IP 표시/그래프 포함), 아키텍처 갱신 |
| 0.1 | 2026-07-21 | 초기 작성 — 요구사항 조사, 현재 ingest-daemon API 실태 파악, 요청 항목별 데이터 출처 매핑, 아키텍처 초안, 사용자 확인 필요 사항 정리. 구현 미착수. |
