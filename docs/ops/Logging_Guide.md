# LTS-2026 Logging Guide

**Version:** 1.0
**대상 서버:** `npm run start` / `npm run streaming` / `npm run analysis` (프로덕션 모드)

---

## 개요

프로덕션 실행(`npm run start` 계열) 시 모든 로그에 `[YY-MM-DD HH:mm:ss.sss]` 타임스탬프가 자동으로 붙고, 일별 로그 파일로 저장됩니다.

| 구성 요소 | 타임스탬프 적용 방식 |
|---|---|
| 서버(`index.js`) | stdout/stderr 파이프 → `makeLineRelay()` |
| MediaMTX 자식 프로세스 | stdout/stderr 파이프 → `makeLineRelay('[MediaMTX]')` |
| Ingest Daemon 자식 프로세스 | stdout/stderr 파이프 → `makeLineRelay('[Ingest]')` |
| `startServer.js` 자체 로그 | `patchConsole()` — console.log/info/warn/error 래핑 |

개발 모드(`npm run dev` 계열 + nodemon)에서는 타임스탬프가 추가되지 않습니다.

---

## 로그 파일 위치

| 경로 | 설명 |
|---|---|
| `/var/log/lts/lts-YYYY-MM-DD.log` | 1차 저장 경로 (권한 필요 — 아래 설정 참고) |
| `server/logs/lts-YYYY-MM-DD.log` | `/var/log/lts` 접근 불가 시 자동 폴백 |

- 파일명은 서버 시작 시 날짜를 기준으로 생성됩니다.
- 자정이 지나면 다음 로그 쓰기 시점에 새 날짜 파일이 자동으로 열립니다 (일별 로테이션).

---

## 초기 설정 — `/var/log/lts` 권한 부여

`/var/log`는 root 소유이므로 최초 1회 sudo로 디렉토리를 생성하고 소유자를 서버 실행 계정으로 변경합니다.

```bash
sudo mkdir -p /var/log/lts
sudo chown $USER:$USER /var/log/lts
```

설정 후 서버를 시작하면 `[Logger] Writing to /var/log/lts/lts-YYYY-MM-DD.log` 메시지가 출력됩니다.

---

## 환경변수

`server/.env` (또는 모드별 env 파일)에서 설정합니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `LOG_TO_FILE` | `true` | `false`로 설정하면 파일 저장 비활성화 (stdout만 출력) |
| `LOG_DIR` | `/var/log/lts` | 로그 파일 저장 디렉토리. 폴백: `server/logs/` |

---

## 로그 형식

```
[26-06-19 13:45:30.012] [MediaMTX] INF RTSP listener opened ...
[26-06-19 13:45:30.234] [Ingest] INFO [eb5f7bb4] AI loop started
[26-06-19 13:45:30.456] [DB] MongoDB connected to lts
[26-06-19 13:45:30.789] [Server] listening on port 3443
```

| 필드 | 형식 | 예시 |
|---|---|---|
| 타임스탬프 | `[YY-MM-DD HH:mm:ss.sss]` | `[26-06-19 13:45:30.012]` |
| 컴포넌트 접두어 | `[MediaMTX]` / `[Ingest]` / (없음 = 서버) | |
| 메시지 | 원본 로그 내용 | |

---

## 로그 조회

```bash
# 오늘 로그 전체 확인
cat /var/log/lts/lts-$(date +%Y-%m-%d).log

# 실시간 스트리밍
tail -f /var/log/lts/lts-$(date +%Y-%m-%d).log

# 에러 필터
grep -E "ERROR|WARN|error|warn" /var/log/lts/lts-$(date +%Y-%m-%d).log

# 특정 카메라 로그 필터
grep "eb5f7bb4" /var/log/lts/lts-$(date +%Y-%m-%d).log

# 날짜 범위 조회 (예: 최근 3일)
cat /var/log/lts/lts-$(date -d '2 days ago' +%Y-%m-%d).log \
    /var/log/lts/lts-$(date -d '1 day ago' +%Y-%m-%d).log \
    /var/log/lts/lts-$(date +%Y-%m-%d).log | less
```

---

## 구현 상세

### 관련 파일

| 파일 | 역할 |
|---|---|
| `server/src/utils/logger.js` | 핵심 로거 — `formatTs`, `patchConsole`, `openLogFile`, `makeLineRelay` |
| `server/src/scripts/startServer.js` | 서버 시작 시 로거 초기화, 자식 프로세스 stdio 파이프 연결 |

### 동작 방식

```
startServer.js
├── openLogFile()          → /var/log/lts/lts-YYYY-MM-DD.log 열기
├── patchConsole()         → console.{log,info,warn,error} 패치
├── spawn(mediamtx)
│   ├── stdout → makeLineRelay('[MediaMTX]', process.stdout) → 파일
│   └── stderr → makeLineRelay('[MediaMTX]', process.stderr) → 파일
├── spawn(ingest_daemon.py)
│   ├── stdout → makeLineRelay('[Ingest]', process.stdout) → 파일
│   └── stderr → makeLineRelay('[Ingest]', process.stderr) → 파일
└── spawn(index.js)  ← stdio: ['inherit', 'pipe', 'pipe']
    ├── stdout → makeLineRelay('', process.stdout) → 파일
    └── stderr → makeLineRelay('', process.stderr) → 파일
```

`index.js`(메인 서버)는 `stdio: 'pipe'`로 스폰되므로 별도 패치 없이도 타임스탬프가 붙습니다.

---

## 파일 보존 정책

자동 삭제 기능은 포함되어 있지 않습니다. 필요 시 cron으로 오래된 파일을 삭제합니다.

```bash
# 30일 이상 된 로그 삭제 (crontab -e 에 추가)
0 0 * * * find /var/log/lts -name 'lts-*.log' -mtime +30 -delete
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-19 | 초기 작성 — startServer.js 타임스탬프 로깅 및 /var/log/lts 파일 저장 |
