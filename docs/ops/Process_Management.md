# LTS-2026 프로세스 관리 가이드

**Version: 1.1**
**Last Updated: 2026-07-28**

---

## 개요

`npm run start` (및 `streaming`, `analysis`) 계열 명령어는 `startServer.js`를 통해 하위 프로세스를 관리합니다.

```
startServer.js (PID: A)
├── mediamtx          (PID: B) — RTSP/WebRTC 미디어 프록시
├── ingest-daemon × N (PID: C0, C1, ... C(N-1)) — Python PyAV RTSP 캡처 (INGEST_DAEMON_INSTANCES, 기본 1, §6.45)
└── index.js (서버)   (PID: D)
    ├── yt-dlp        (PID: E) — YouTube 스트림 다운로드
    │   └── ffmpeg    (PID: E') — yt-dlp 내부 다운로더 (HLS 라이브/DASH mux 시에만 생성 — grandchild, Node에서 직접 핸들 없음)
    └── ffmpeg        (PID: F) — RTSP 인코딩/릴레이 (yt-dlp stdout → RTSP publish)
```

`ingest-daemon`이 여러 인스턴스로 나뉜 경우(§6.45, GIL thrashing 구조적 해법) 각 인스턴스는 독립된
포트(`INGEST_DAEMON_BASE_PORT + index*10`, 기본 7070/7080/7090/...)에서 리스닝하는 별도 OS 프로세스이며,
카메라는 `cameraId` 해시로 인스턴스에 결정론적으로 배정된다(재시작마다 재계산, 영속화 없음). 자세한 내용은
`docs/design/Design_RTSP_Capture_Backend.md` §6.45와 `docs/ops/Ingest_Daemon_Control_Guide.md` §8 참고.

---

## 정상 종료 방법

### 방법 1: Ctrl+C (대화형 터미널)

터미널에서 서버를 직접 실행 중일 때 Ctrl+C를 누르면 전체 프로세스 그룹에 SIGINT가 전달됩니다.

**종료 순서:**
1. startServer.js가 SIGINT 수신 → shutdown() 호출 (재진입 방지 가드 포함)
2. mediamtx, ingest-daemon, index.js에 SIGINT 전달
3. index.js: 내부 graceful shutdown → `youtubeSvc.stopAll()` → yt-dlp/ffmpeg 종료
4. index.js 종료 → startServer.js의 `child.on('exit')` 핸들러 실행
5. 신호 핸들러 제거 후 `process.kill(pid, signal)` → 기본 종료 동작으로 startServer.js 종료
6. 12초 타임아웃 초과 시 SIGKILL 강제 종료

### 방법 2: npm run stop (백그라운드 실행 중)

```bash
cd server
npm run stop          # combined 서버 (포트 3080/3443) + 고아 프로세스 정리
npm run stop:streaming
npm run stop:analysis
```

**종료 순서:**
1. 포트 3080/3443에서 리스닝 중인 index.js PID 탐색
2. SIGTERM 전송 → graceful shutdown (yt-dlp/ffmpeg 정상 종료)
3. 10초 대기 후 포트 미반납 시 SIGKILL 강제 종료
4. `mediamtx`, `ingest_daemon.py` 프로세스를 이름으로 탐색하여 SIGTERM 전송
5. 3초 대기 후 SIGKILL로 잔여 프로세스 강제 종료

---

## 수동 프로세스 확인 및 종료

```bash
# 모든 LTS 관련 프로세스 확인
ps -ef | grep -E "mediamtx|ingest_daemon|index.js|ffmpeg|yt-dlp" | grep -v grep

# 개별 강제 종료
pkill -f mediamtx
pkill -f ingest_daemon.py          # 이름 기반 — 멀티 인스턴스(§6.45)여도 전 인스턴스가 함께 종료됨(의도된 동작,
                                    # "전체 종료" 시나리오이므로 무방). 인스턴스 1개만 종료하려면
                                    # `pkill -f "ingest_daemon.py --addr :<port>"`로 cmdline까지 매칭할 것
                                    # (Admin API/`ingestDaemonControl.js`가 내부적으로 사용하는 패턴과 동일).
pkill -f "loitering_tracking/server/src/index.js"

# yt-dlp / ffmpeg (LTS 경유 프로세스만)
pkill -f "8554/"    # MediaMTX RTSP 경유 ffmpeg
```

---

## mcp-server 별도 관리

`mcp-server`는 `startServer.js`와 **독립적인 프로세스**입니다. `npm run stop`은 mcp-server를 종료하지 않습니다.

```bash
# mcp-server 수동 종료
pkill -f "loitering_tracking/mcp-server"

# 또는 claude.ai/code 내 MCP 서버 설정에서 제거
```

---

## 알려진 동작

| 상황 | 동작 |
|------|------|
| Ctrl+C (대화형) | 전체 프로세스 그룹 SIGINT → 정상 종료 |
| `npm run stop` | 포트 기반 종료 + mediamtx/ingest-daemon 이름 기반 정리 |
| index.js가 SIGKILL로 강제 종료 | yt-dlp/ffmpeg가 고아 프로세스로 잔존 가능 → `npm run stop`으로 정리 |
| startServer.js 비정상 종료 | mediamtx/ingest-daemon 고아 잔존 → `npm run stop`으로 정리 |
| YouTube 채널 삭제(`DELETE /api/youtube-streams/:id`) | yt-dlp와 이 프로세스가 낳은 outer ffmpeg는 정상 종료됨. yt-dlp의 **내부** ffmpeg 다운로더(HLS 라이브/DASH mux 시에만 생성, Node에서 직접 핸들 없는 grandchild)까지 정리하려면 `youtubeStreamService.js`의 `findChildPids()`가 부모(yt-dlp) 시그널 전송 **전에** 자식 PID를 미리 캡처해둬야 함 — Linux는 부모가 종료되는 즉시 orphan을 init으로 reparent하므로, 부모의 close 이벤트를 기다린 뒤 `pgrep -P`로 스캔하면 이미 늦어 고아가 영구 잔존한다(2026-07-28 수정, 아래 관련 코드 참고) |

---

## 관련 코드

| 파일 | 역할 |
|------|------|
| `server/src/scripts/startServer.js` | 자식 프로세스 생성·신호 전달·graceful shutdown |
| `server/src/scripts/stopServer.js` | 포트 기반 + 이름 기반 프로세스 종료 |
| `server/src/index.js` | SIGTERM/SIGINT 수신 시 `youtubeSvc.stopAll()` 호출 |
| `server/src/services/youtubeStreamService.js` | yt-dlp/ffmpeg 생성 및 `stopAll()` 구현. `findChildPids()`/`killProcessTree()` — 프로세스 트리 정리(2026-07-28 reparenting 레이스 수정) |
| `server/src/services/ingestDaemonPool.js` | (§6.45) 멀티 인스턴스 fleet의 포트/인스턴스 개수 단일 소스 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.1 | 2026-07-28 | 프로세스 트리 다이어그램에 멀티 인스턴스 ingest-daemon(§6.45)·yt-dlp 내부 ffmpeg grandchild 반영, YouTube 채널 삭제 시 프로세스 트리 정리 레이스 수정 설명 추가 |
| 1.0 | 2026-06-19 | 초기 작성 — 프로세스 종료 흐름, npm run stop 개선, mcp-server 분리 설명 |
