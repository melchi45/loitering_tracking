# LTS-2026 Logging Guide

**Version:** 2.0
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
| `LOG_DIR` | `/var/log/lts` | 로그 파일 저장 디렉토리. 폴백: `server/logs/`. **최초 부팅 시에만** 참조되며 이후에는 Admin Dashboard 설정(`settings` 테이블)이 우선함 — §"로그 저장 경로 및 로테이션 설정" 참고 |
| `LOG_LEVEL` | `INFO` | 최소 출력 레벨 (`DEBUG`/`INFO`/`WARNING`/`ERROR`/`CRITICAL`/`NONE`) |
| `LOG_FILTER_PATTERNS` | `` (비어 있음) | 쉼표 구분 정규식 — 매칭 줄 강제 억제 |
| `LOG_MAX_FILE_SIZE_MB` | `50` | 활성 로그 파일이 이 크기(MB)를 넘으면 분할(split). **최초 부팅 시에만** 참조 |
| `LOG_MAX_FILES` | `10` | 보관할 분할(아카이브) 로그 파일 최대 개수 — 초과 시 가장 오래된 파일부터 삭제. **최초 부팅 시에만** 참조 |

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
| `/var/log/lts/lts-YYYY-MM-DD.log` | 1차 저장 경로(기본값 — Admin Dashboard에서 변경 가능) |
| `server/logs/lts-YYYY-MM-DD.log` | 설정된 디렉터리 접근 불가 시 자동 폴백 |
| `<디렉터리>/lts-YYYY-MM-DD_HHmmssSSS-N.log` | 크기 초과로 분할(rotate)된 아카이브 파일 — 아래 §"로그 저장 경로 및 로테이션 설정" 참고 |

자정이 지나면 다음 로그 쓰기 시점에 새 날짜 파일이 자동으로 열립니다.

---

## 로그 저장 경로 및 로테이션(분할) 설정

**Admin Dashboard → System → Log Storage & Rotation** 패널에서 다음 3가지를 설정합니다.

| 설정 | 설명 | 기본값 |
|---|---|---|
| 저장 경로 (dir) | 로그 파일이 저장될 디렉터리. 저장 전 실제 쓰기 가능 여부를 검증하며, 실패 시 400과 함께 기존 값이 유지됨 | `/var/log/lts` |
| 최대 파일 크기 (maxFileSizeMB) | 활성 파일이 이 크기를 넘으면 즉시 분할 | 50 MB |
| 최대 보관 개수 (maxFiles) | 분할된 아카이브 파일의 최대 보관 개수 — 초과 시 mtime 기준 가장 오래된 파일부터 삭제 | 10 |

### 동작 방식

- 값은 `settings` 테이블(row id `logConfig`)에 영속화되며, `server/.env`의 `LOG_DIR`/`LOG_MAX_FILE_SIZE_MB`/`LOG_MAX_FILES`는 **테이블에 아무 값도 없는 최초 부팅 시에만** 시드 값으로 쓰입니다. 이후에는 Admin Dashboard 설정이 유일한 소스입니다(`activeModelConfig.js`의 AI 모델 Active 선택 영속화와 동일한 패턴).
- 분할 시 활성 파일이 `lts-YYYY-MM-DD_HHmmssSSS-N.log`(시:분:초.밀리초 + 순번)로 이름이 바뀌고, 원래 날짜 파일명으로 새 활성 파일이 열립니다. 자정 날짜 롤오버가 일어난 뒤에도 동일하게 보관 개수 정책이 적용됩니다(날짜 롤오버와 크기 롤오버 어느 쪽이든 오래된 파일 삭제 대상은 동일).
- "지금 분할(Rotate Now)" 버튼으로 크기와 무관하게 즉시 분할을 트리거할 수 있습니다 — 운영/테스트 용도.
- **기존 cron 기반 삭제 예시(아래)는 이제 선택 사항입니다.** 개수 기반 자동 삭제가 내장되었으므로, 특정 보존 "기간"(예: "무조건 90일 뒤엔 삭제") 정책이 별도로 필요한 경우에만 cron을 보조로 유지하세요.

### 아키텍처: 왜 부모/자식 프로세스 간 IPC가 필요한가

실제 로그 파일 쓰기(`openLogFile`/`patchConsole`/파일 write)는 **`server/src/scripts/startServer.js`(부모/슈퍼바이저 프로세스)** 안에서 일어납니다. 이 프로세스가 실제 Express 서버(`server/src/index.js`, Admin API가 사는 곳)를 **자식 프로세스로 spawn**하고 그 stdout/stderr를 파이프로 받아 파일에 기록하기 때문입니다. 즉 Admin API(자식)에서 설정을 바꿔도 부모에 전달되지 않으면 실제 파일에는 반영되지 않습니다.

```
Admin Dashboard (브라우저)
   │  PUT /admin/system/logs
   ▼
index.js (자식 프로세스, Admin API)
   │  1) settings 테이블에 영속화 (logConfigService.js)
   │  2) 자신의 utils/logger.js 인스턴스에도 적용 (조회/tailLogFile용)
   │  3) process.send({ type: 'lts:logConfig', payload }) — IPC
   ▼
startServer.js (부모/슈퍼바이저 프로세스, 실제 파일 writer)
   │  child.on('message', ...) → logger.setLogConfig(payload)
   ▼
실제 로그 파일 (openLogFile / _rotate / _enforceMaxFiles)
```

- `npm run dev*`(개발 모드)에는 이 부모/자식 구조 자체가 없고 logger.js도 로드되지 않으므로, 설정은 저장되지만 실제로 아무 파일에도 반영되지 않습니다. Admin API 응답의 `ipcAvailable: false`가 이를 알려줍니다.
- 서버 재시작 시 `index.js`가 DB 초기화 직후 `logConfigService.restoreOnBoot()`를 호출해 영속화된 설정을 자신의 logger.js 인스턴스에 적용하고, `process.send`가 존재하면(프로덕션) 부모에도 동일하게 전파합니다 — 관리자가 설정을 바꿔놓은 뒤 재기동해도 그대로 유지됩니다.
- combined/streaming/analysis 세 `SERVER_MODE` 모두 `startServer.js → index.js` 구조를 공유하므로 모드별 분기 코드가 필요 없습니다.

상세 설계: [`Design_Log_Rotation.md`](../design/Design_Log_Rotation.md).

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
| `server/src/utils/logger.js` | 핵심 로거 모듈 — 파일 쓰기, 크기 기반 로테이션(`_rotate`), 개수 기반 정리(`_enforceMaxFiles`) |
| `server/src/services/logConfigService.js` | 로그 저장 경로/로테이션 설정의 `settings` 테이블 영속화 + 부팅 시 복원 |
| `server/src/routes/admin.js` | `GET/PUT /admin/system/logs`, `POST /admin/system/logs/rotate` |
| `client/src/components/LogRotationPanel.tsx` | Admin Dashboard → System 로그 저장 경로/로테이션 설정 UI |
| `server/src/scripts/startServer.js` | 시작 시 로거 초기화, 자식 프로세스 stdio 연결 + IPC(`'ipc'` stdio)로 logConfig 변경 수신 |

### 동작 흐름

```
startServer.js  (부모/슈퍼바이저 — 실제 파일 writer)
├── openLogFile()           → <설정된 dir>/lts-YYYY-MM-DD.log
├── patchConsole()          → console.{log,info,warn,error,debug} 패치
│                              레벨 필터링 → 타임스탬프 + [LEVEL] 태그
├── child.on('message')     → IPC로 받은 logConfig를 logger.setLogConfig()에 적용 (§로테이션 설정)
├── spawn(mediamtx)
│   ├── stdout → makeLineRelay('[MediaMTX]', process.stdout)
│   └── stderr → makeLineRelay('[MediaMTX]', process.stderr)
├── spawn(ingest_daemon.py)
│   ├── stdout → makeLineRelay('[Ingest]', process.stdout)
│   └── stderr → makeLineRelay('[Ingest]', process.stderr)
└── spawn(index.js)  ← stdio: ['inherit', 'pipe', 'pipe', 'ipc']
    ├── stdout → makeLineRelay('', process.stdout)
    └── stderr → makeLineRelay('', process.stderr)
              ↓
    레벨 감지 → 레벨 필터 → 패턴 억제 → [ts] [LEVEL] 출력 + 파일 저장
              ↓ (파일 크기 ≥ maxFileSizeMB)
    _rotate() → 아카이브로 rename + 새 활성 파일 open → _enforceMaxFiles()
```

---

## 로그 보존 정책

**개수 기반 자동 삭제가 내장되어 있습니다** — 위 §"로그 저장 경로 및 로테이션 설정"의 최대 보관 개수(maxFiles)를 초과하면 가장 오래된 아카이브 파일이 자동 삭제됩니다. 별도 cron 설정 없이도 디스크 사용량이 무한정 늘어나지 않습니다.

특정 보존 "기간"(예: "무조건 90일 지나면 삭제")이 개수 기준과 별개로 필요하다면 cron을 보조로 유지할 수 있습니다:

```bash
# 90일 이상 된 로그 삭제 (crontab -e 에 추가) — 선택 사항, 개수 기반 정책과 병행 가능
0 0 * * * find /var/log/lts -name 'lts-*.log' -mtime +90 -delete
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-19 | 초기 작성 — startServer.js 타임스탬프 로깅 및 /var/log/lts 파일 저장 |
| 1.1 | 2026-06-19 | 로그 레벨 시스템 추가 — DEBUG/INFO/WARNING/ERROR/CRITICAL, ffmpeg 자동 하향, LOG_FILTER_PATTERNS |
| 2.0 | 2026-08-26 | Admin Dashboard → System에서 로그 저장 경로·최대 파일 크기·최대 보관 개수 설정 기능 추가 (크기 기반 로테이션/split + 개수 기반 자동 삭제). `settings` 테이블 영속화 + startServer.js↔index.js IPC 아키텍처 도입, combined/streaming/analysis 전 모드 공통 동작. 상세: [`Design_Log_Rotation.md`](../design/Design_Log_Rotation.md) |
