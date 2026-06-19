# LTS-2026 프로세스 관리 가이드

**Version: 1.0**
**Last Updated: 2026-06-19**

---

## 개요

`npm run start` (및 `streaming`, `analysis`) 계열 명령어는 `startServer.js`를 통해 3개의 하위 프로세스를 관리합니다.

```
startServer.js (PID: A)
├── mediamtx          (PID: B) — RTSP/WebRTC 미디어 프록시
├── ingest-daemon     (PID: C) — Python PyAV RTSP 캡처
└── index.js (서버)   (PID: D)
    ├── yt-dlp        (PID: E) — YouTube 스트림 다운로드
    └── ffmpeg        (PID: F) — RTSP 인코딩/릴레이
```

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
pkill -f ingest_daemon.py
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

---

## 관련 코드

| 파일 | 역할 |
|------|------|
| `server/src/scripts/startServer.js` | 자식 프로세스 생성·신호 전달·graceful shutdown |
| `server/src/scripts/stopServer.js` | 포트 기반 + 이름 기반 프로세스 종료 |
| `server/src/index.js` | SIGTERM/SIGINT 수신 시 `youtubeSvc.stopAll()` 호출 |
| `server/src/services/youtubeStreamService.js` | yt-dlp/ffmpeg 생성 및 `stopAll()` 구현 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-19 | 초기 작성 — 프로세스 종료 흐름, npm run stop 개선, mcp-server 분리 설명 |
