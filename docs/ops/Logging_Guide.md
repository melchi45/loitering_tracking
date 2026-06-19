# LTS-2026 Logging Guide

**Version:** 1.1
**대상 서버:** `npm run start` / `npm run streaming` / `npm run analysis` (프로덕션 모드)

---

## 개요

프로덕션 실행(`npm run start` 계열) 시 모든 로그에 타임스탬프와 레벨 태그가 자동으로 붙고, 일별 로그 파일로 저장됩니다.

**출력 형식**
```
[26-06-19 13:45:30.012] [INFO]     [DB] MongoDB connected to lts
[26-06-19 13:45:30.234] [WARNING]  [MediaMTX] Port 8554 already in use
[26-06-19 13:45:30.456] [ERROR]    Failed to start pipeline for eb5f7bb4
[26-06-19 13:45:30.789] [DEBUG]    [Ingest] [eb5f7bb4] packet received
```

| 컴포넌트 | 처리 방식 |
|---|---|
| 서버(`index.js`) | stdout/stderr 파이프 → `makeLineRelay()` |
| MediaMTX 자식 프로세스 | stdout/stderr 파이프 → `makeLineRelay('[MediaMTX]')` |
| Ingest Daemon 자식 프로세스 | stdout/stderr 파이프 → `makeLineRelay('[Ingest]')` |
| `startServer.js` 자체 로그 | `patchConsole()` — console.log/info/warn/error 래핑 |

개발 모드(`npm run dev` 계열 + nodemon)에서는 이 logger가 로드되지 않습니다.

---

## 로그 레벨

| 레벨 | 값 | 설명 |
|---|---|---|
| `DEBUG` | 10 | 상세 진단 정보 (ffmpeg/yt-dlp HLS 메타데이터 포함) |
| `INFO` | 20 | 정상 운영 메시지 **[기본값]** |
| `WARNING` | 30 | 잠재적 문제 (운영 지속 가능) |
| `ERROR` | 40 | 기능 실패 (카메라/파이프라인 오류 등) |
| `CRITICAL` | 50 | 치명적 오류 (서버 종료 수준) |
| `NONE` | 100 | 모든 출력 비활성화 |

`LOG_LEVEL=INFO`(기본)로 설정 시 `DEBUG` 메시지가 필터링됩니다.  
이는 yt-dlp/ffmpeg의 `[hls @ 0x...]` 형태 HLS 메타데이터 노이즈를 자동으로 제거합니다.

### console 메서드 → 레벨 매핑

| 서버 코드 호출 | 출력 레벨 |
|---|---|
| `console.debug()` | DEBUG |
| `console.log()` | INFO |
| `console.info()` | INFO |
| `console.warn()` | WARNING |
| `console.error()` | ERROR |

### 자식 프로세스 출력 레벨 자동 감지

자식 프로세스(MediaMTX, Ingest Daemon, 서버)의 raw 출력은 다음 규칙으로 레벨을 감지합니다:

| 우선순위 | 조건 | 감지 레벨 |
|---|---|---|
| 1 | `critical` / `fatal` 키워드 포함 | CRITICAL |
| 2 | `error` / `failed` / `failure` / `exception` 키워드 포함 | ERROR |
| 3 | `warn` / `warning` / `wrn` 키워드 포함 | WARNING |
| 4 | `[xxx @ 0x...]` 패턴 포함 (ffmpeg 컴포넌트 verbose) | DEBUG ← 자동 하향 |
| 5 | `debug` / `dbg` / `verbose` 키워드 포함 | DEBUG |
| 6 | 그 외 모두 | INFO |

> **4번 규칙**: `[hls @ 0x5558...]`, `[mp4 @ 0x...]` 등 ffmpeg 컴포넌트 접두어를 가진 줄은 ERROR/WARNING 키워드가 없으면 자동으로 DEBUG로 하향됩니다. `LOG_LEVEL=INFO` 설정만으로 이 노이즈가 제거됩니다.

---

## 환경변수

`server/.env` (또는 모드별 env 파일)에서 설정합니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `LOG_TO_FILE` | `true` | `false`로 설정하면 파일 저장 비활성화 |
| `LOG_DIR` | `/var/log/lts` | 로그 파일 저장 디렉토리. 폴백: `server/logs/` |
| `LOG_LEVEL` | `INFO` | 최소 출력 레벨 (`DEBUG`/`INFO`/`WARNING`/`ERROR`/`CRITICAL`/`NONE`) |
| `LOG_FILTER_PATTERNS` | `` (비어 있음) | 쉼표 구분 정규식 — 매칭 줄 강제 억제 |

### LOG_FILTER_PATTERNS 사용 예

```bash
# 특정 광고 큐포인트 이벤트만 추가 억제 (PREDICT 단계만)
LOG_FILTER_PATTERNS=EXT-X-DATERANGE.*PREDICT,EXT-X-CUEPOINT.*PREDICT

# ffmpeg HLS 파일 열기 메시지 추가 억제
LOG_FILTER_PATTERNS=\[hls @.*\] Opening '

# 여러 패턴 조합
LOG_FILTER_PATTERNS=EXT-X-DATERANGE.*AD,\[segment @.*\] Opening
```

> `LOG_LEVEL=INFO`로 설정하면 `[hls @ 0x...] Skip` 줄 전체가 이미 DEBUG로 감지되어 필터링됩니다. `LOG_FILTER_PATTERNS`는 그 이상의 세밀한 제어가 필요할 때만 사용합니다.

---

## 로그 파일 위치

| 경로 | 설명 |
|---|---|
| `/var/log/lts/lts-YYYY-MM-DD.log` | 1차 저장 경로 |
| `server/logs/lts-YYYY-MM-DD.log` | `/var/log/lts` 접근 불가 시 자동 폴백 |

자정이 지나면 다음 로그 쓰기 시점에 새 날짜 파일이 자동으로 열립니다.

---

## 초기 설정 — `/var/log/lts` 권한 부여

```bash
sudo mkdir -p /var/log/lts
sudo chown $USER:$USER /var/log/lts
```

설정 후 서버 시작 시 `[Logger] Writing to /var/log/lts/lts-YYYY-MM-DD.log (level=INFO)` 메시지가 출력됩니다.

---

## 로그 조회

```bash
# 오늘 로그 전체
cat /var/log/lts/lts-$(date +%Y-%m-%d).log

# 실시간 스트리밍
tail -f /var/log/lts/lts-$(date +%Y-%m-%d).log

# 레벨별 필터
grep '\[ERROR\]'    /var/log/lts/lts-$(date +%Y-%m-%d).log
grep '\[WARNING\]'  /var/log/lts/lts-$(date +%Y-%m-%d).log
grep -E '\[ERROR\]|\[CRITICAL\]' /var/log/lts/lts-$(date +%Y-%m-%d).log

# 특정 카메라 로그
grep 'eb5f7bb4' /var/log/lts/lts-$(date +%Y-%m-%d).log

# YouTubeStream 관련 오류만
grep '\[ERROR\].*YouTubeStream' /var/log/lts/lts-$(date +%Y-%m-%d).log
```

---

## 구현 상세

### 관련 파일

| 파일 | 역할 |
|---|---|
| `server/src/utils/logger.js` | 핵심 로거 모듈 |
| `server/src/scripts/startServer.js` | 시작 시 로거 초기화 및 자식 프로세스 stdio 연결 |

### 동작 흐름

```
startServer.js
├── openLogFile()           → /var/log/lts/lts-YYYY-MM-DD.log
├── patchConsole()          → console.{log,info,warn,error,debug} 패치
│                              레벨 필터링 → 타임스탬프 + [LEVEL] 태그
├── spawn(mediamtx)
│   ├── stdout → makeLineRelay('[MediaMTX]', process.stdout)
│   └── stderr → makeLineRelay('[MediaMTX]', process.stderr)
├── spawn(ingest_daemon.py)
│   ├── stdout → makeLineRelay('[Ingest]', process.stdout)
│   └── stderr → makeLineRelay('[Ingest]', process.stderr)
└── spawn(index.js)  ← stdio: ['inherit', 'pipe', 'pipe']
    ├── stdout → makeLineRelay('', process.stdout)
    └── stderr → makeLineRelay('', process.stderr)
              ↓
    레벨 감지 → 레벨 필터 → 패턴 억제 → [ts] [LEVEL] 출력 + 파일 저장
```

---

## 로그 보존 정책

자동 삭제 기능은 내장되어 있지 않습니다. cron으로 관리합니다:

```bash
# 30일 이상 된 로그 삭제 (crontab -e 에 추가)
0 0 * * * find /var/log/lts -name 'lts-*.log' -mtime +30 -delete
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-19 | 초기 작성 — startServer.js 타임스탬프 로깅 및 /var/log/lts 파일 저장 |
| 1.1 | 2026-06-19 | 로그 레벨 시스템 추가 — DEBUG/INFO/WARNING/ERROR/CRITICAL, ffmpeg 자동 하향, LOG_FILTER_PATTERNS |
