# DESIGN DOCUMENT
# Ingest Daemon Start/Stop/Restart Control — Admin Dashboard

| | |
|---|---|
| **Document ID** | DESIGN-INGEST-CONTROL-001 |
| **Version** | 1.0 |
| **Status** | Active — 결정 확정, 구현 완료 |
| **Date** | 2026-07-23 |
| **Related Design** | [Design_Ingest_Daemon_Monitoring.md](Design_Ingest_Daemon_Monitoring.md) (같은 Admin Dashboard 패널, 모니터링 전용) · [Design_Admin_Dashboard.md](Design_Admin_Dashboard.md) §4.6 · [Design_RTSP_Capture_Backend.md](Design_RTSP_Capture_Backend.md) §6.29.9(자동 복구 watchdog)/§6.35(재시작 스크립트 포트 확인 버그) |

---

## 1. Requirement

Administrator 계정으로 로그인한 사용자가 **Streaming Server 모드**의 Admin Dashboard → Ingest Daemon 섹션에서, ingest-daemon 프로세스를 **Start / Stop / Restart**할 수 있는 API와 UI 컨트롤을 추가한다.

- 신규 REST API — 호출 시 실제로 ingest-daemon 프로세스를 시작/정지/재시작
- Administrator 역할만 호출 가능 (기존 `/admin/*` 라우터와 동일한 인증·인가)
- Admin Dashboard의 기존 `IngestDaemonSection`(모니터링 전용, [[Design_Ingest_Daemon_Monitoring.md]])에 컨트롤 UI 추가

---

## 2. 현재 상태 조사 결과

### 2.1 기존 CLI 스크립트 (재사용 대상)

| 스크립트 | npm 스크립트 | 동작 |
|---|---|---|
| `server/src/scripts/startIngestDaemon.js` | `ingest:start` | 이미 실행 중이면 `/health` 확인 후 no-op 종료. 아니면 새로 spawn(`detached:true`) → `/health` 폴링(최대 10s) → `POST /api/internal/ingest/reregister`로 카메라 재등록(실패 시 DB 직접 읽기 폴백) |
| `server/src/scripts/stopIngestDaemon.js` | `ingest:stop` | `isRunning()`(`/health` 요청)으로 실행 여부 확인 → 실행 중이면 `fuser -k PORT/tcp` + `pkill -f ingest_daemon.py` → 포트 해제 대기(최대 3s) |
| `server/src/scripts/restartIngestDaemon.js` | `ingest:restart` | `killExistingDaemon()`(SIGTERM → 8s 대기 → SIGKILL 승급, §6.35에서 방금 `isPortFree()` bind 테스트로 수정) → `startDaemon()` spawn → `/health` 폴링 → 카메라 재등록 |

세 스크립트 모두 **모듈 최상위 IIFE**로 작성되어 있어(`(async () => {...})()`), 함수를 외부에서 `require()`해 재사용할 수 없다 — CLI 전용. API가 이 로직을 재사용하려면 다음 중 하나가 필요:
- (A) 각 스크립트의 핵심 로직을 `server/src/services/ingestDaemonControl.js` 같은 서비스 모듈로 추출해 CLI 스크립트와 API 핸들러가 공동으로 `require()` (DRY, 로직 drift 방지 — `restartIngestDaemon.js`가 최근 겪은 것과 같은 종류의 버그가 두 곳에 따로 존재하게 되는 상황을 피함)
- (B) API 핸들러가 `child_process.exec('npm run ingest:start')`처럼 CLI를 그대로 shell-out

**(A)를 권장** — 로직이 한 곳에만 존재해야 §6.35류 버그 수정이 CLI/API 양쪽에 동시 적용된다. `startIngestDaemon.js`/`stopIngestDaemon.js`/`restartIngestDaemon.js`는 얇은 CLI 래퍼(인자 파싱 + 종료 코드 + 콘솔 출력)로 남기고, 실질 로직은 서비스 모듈로 이동.

### 2.2 발견된 버그 — `stopIngestDaemon.js`의 좀비 데몬 오탐

`stopIngestDaemon.js`의 `isRunning()`은 `/health` HTTP 응답 성공 여부만으로 "실행 중"을 판단한다. 그런데 이번 세션에서 실제로 겪은 것처럼(§6.29.5, §6.35) ingest-daemon은 **프로세스가 살아있고 CPU를 소모하면서도 HTTP API에는 전혀 응답하지 않는 "좀비" 상태**에 빠질 수 있다 — 바로 관리자가 Stop/Restart 버튼을 누르고 싶어할 정확한 상황이다. 이 경우 `isRunning()`은 `/health` 타임아웃으로 `false`를 반환하고, `stopIngestDaemon.js`는 **"실행 중이 아님"으로 오판해 kill 로직 자체를 건너뛴다** — 실제로는 프로세스가 여전히 포트를 쥐고 있는데도.

이 버그는 §6.35에서 `restartIngestDaemon.js`에 적용한 것과 같은 클래스의 문제이며, 이번 기능(특히 "Stop"·"Restart" API)이 정확히 이 시나리오(좀비 데몬 강제 종료)에서 신뢰할 수 있어야 하므로 **이번 기능 범위에 포함해 함께 수정**한다 — `isPortFree()`(실제 bind 시도) 기반 판정으로 교체하고, `stopIngestDaemon.js`/새 서비스 모듈 양쪽에서 §6.35와 동일한 SIGTERM→SIGKILL 승급 + `pkill -9 -f` 폴백 패턴을 따른다.

**의도적으로 범위 밖에 남긴 것 — `startServer.js`의 크래시 자동재시작 루프(§6.36)**: `_respawnIngest()`/`_killPortOrphan()`은 이번 `ingestDaemonControl.js`로 통합하지 않았다. 그 함수는 (1) 스폰한 자식 프로세스의 `stdout`/`stderr`를 `pipe`로 받아 메인 서버 로그에 `[Ingest]` 접두사로 실시간 relay하고(`makeLineRelay`), (2) 서버 전체 종료 시 그레이스풀 셧다운을 위해 `ingestDaemonChild` 참조를 계속 들고 있어야 한다 — 반면 `ingestDaemonControl.js`의 `spawnDaemon()`은 CLI 스크립트와 동일하게 `stdio: ['ignore', logFd, logFd]`로 별도 로그 파일에 쓰는 detached 프로세스를 만든다. 이 둘을 억지로 합치면 크래시 재시작마다 메인 로그로의 실시간 relay가 조용히 사라지는 회귀가 생긴다 — 실제로 필요하지도 않은 리팩터링(이번 기능은 크래시 자동복구가 아니라 관리자가 누르는 버튼이 대상)이므로 하지 않았다. 두 곳 모두 동일한 `isPortFree()`+`pkill -f`/`pkill -9 -f` 패턴을 쓰지만 구현은 독립적으로 유지된다.

### 2.3 SERVER_MODE / CAPTURE_BACKEND 게이팅

- `GET /api/ingest-status`(`index.js:336`)는 `CAPTURE_BACKEND=ingest-daemon`일 때만 `enabled:true` — 인증 없는 공개 엔드포인트(Streaming Dashboard nav 배지용).
- Admin Dashboard의 `IngestDaemonSection`(모니터링)은 `serverMode !== 'analysis'`일 때 표시 — 즉 **streaming뿐 아니라 combined 모드에서도 이미 보임** (`AdminUsersPage.tsx:219`).
- **확정(§6 Q1)**: 모니터링 패널과 동일하게 combined 모드도 포함 — `CAPTURE_BACKEND=ingest-daemon`이 유일한 게이팅 조건이며 별도 `SERVER_MODE` 체크는 불필요(analysis 모드는 이 백엔드를 쓰지 않으므로 자연히 제외됨).
- `ingestDaemonWatchdog.js`는 `CAPTURE_BACKEND=ingest-daemon`일 때만 기동(`index.js:101`) — 새 API도 동일하게 `CAPTURE_BACKEND=ingest-daemon`이 아니면 501을 반환한다.

### 2.4 인증 패턴 (재사용)

`server/src/routes/admin.js`는 라우터 최상단에서 일괄 게이팅:
```js
router.use(verifyAccessToken);
router.use(requireRole('admin'));
```
이후 각 라우트는 인증된 `req.user`를 그대로 사용. 상태 변경성 액션(`PATCH /admin/logs/level` 등)은 `AuditService.log({event, actorId: req.user.sub, detail})`로 감사 로그를 남긴다 — 신규 API도 동일 패턴(라우터는 `admin.js`에 추가, 각 액션마다 AuditService 로그).

### 2.5 기존 상태 피드백 경로 (재사용 가능)

- `GET /api/ingest-status` — 공개, 1회성 폴링용.
- Socket.IO `admin:ingest-stats`(1.5초 주기, admin 검증된 소켓에만, [[Design_Ingest_Daemon_Monitoring.md]] §8) — 이미 daemon 살아있음/카메라별 상태를 실시간 push 중.
- **확정(§6 Q2)**: API는 동기 완료 대기 방식을 쓴다. 이 두 경로는 버튼 클릭과 무관하게 항상 상태를 보여주는 보조 채널로 유지.

---

## 3. 요청 항목 → 소스 매핑

| 요청 항목 | 구현 위치 |
|---|---|
| Start API | 신규 `POST /admin/ingest/start` — `ingestDaemonControl.js`의 `startDaemon()` 재사용(§2.1 방식 A) |
| Stop API | 신규 `POST /admin/ingest/stop` — `stopDaemon()`, §2.2 버그 수정 포함 |
| Restart API | 신규 `POST /admin/ingest/restart` — `restartDaemon()`, 기존 `restartIngestDaemon.js`(§6.35 수정 반영)의 핵심 로직 재사용 |
| Admin 전용 접근 제어 | 기존 `verifyAccessToken` + `requireRole('admin')` 패턴 재사용 |
| Dashboard UI 버튼 | `client/src/components/IngestDaemonSection.tsx`에 Start/Stop/Restart 버튼 추가 |

---

## 4. 제안 아키텍처

```
┌─────────────────────────┐      POST /admin/ingest/{start,stop,restart}      ┌──────────────────┐
│  IngestDaemonSection.tsx │ ───────────────────────────────────────────────▶ │  admin.js router   │
│  (Start/Stop/Restart btn)│   Authorization: Bearer <JWT>                    │  (verifyAccessToken │
└─────────────────────────┘                                                   │   + requireRole)    │
             ▲                                                                └─────────┬─────────┘
             │  기존 경로로 완료 관찰                                                     │ calls
             │  (admin:ingest-stats / GET /api/ingest-status)                            ▼
             │                                                                ┌──────────────────────┐
             └──────────────────────────────────────────────────────────────│ ingestDaemonControl.js │
                                                                              │  startDaemon()         │
                                                                              │  stopDaemon()          │
                                                                              │  restartDaemon()       │
                                                                              └───────────┬────────────┘
                                                                                          │ spawn / kill / http
                                                                                          ▼
                                                                              ┌──────────────────────┐
                                                                              │  ingest_daemon.py :7070│
                                                                              └──────────────────────┘

CLI 스크립트(ingest:start/stop/restart)는 동일 ingestDaemonControl.js를 얇게 감싸는 래퍼로 리팩터링 —
로직 중복 제거, §6.35류 버그가 CLI/API 양쪽에 따로 존재하지 않도록 함.
```

### 4.1 API (확정)

| 메서드 | 경로 | 동작 | 응답 |
|---|---|---|---|
| POST | `/admin/ingest/start` | 미실행 시 daemon 시작 + 카메라 재등록 | `{ ok, alreadyRunning?, pid? }` |
| POST | `/admin/ingest/stop` | daemon 종료(좀비 상태 포함, §2.2 수정 반영) | `{ ok, wasRunning }` |
| POST | `/admin/ingest/restart` | 종료 후 재시작 + 카메라 재등록 | `{ ok, pid, cameras: {...} }` (기존 `restartIngestDaemon.js` 로그와 동일 정보) |

3개 라우트 공통:
- `CAPTURE_BACKEND !== 'ingest-daemon'`이면 `501 { error: 'ingest-daemon backend not active' }` (Q1 확정 — SERVER_MODE 체크는 불필요)
- 동기 응답(Q2 확정) — restart는 최대 ~11초 걸릴 수 있어 클라이언트 fetch에 타임아웃을 걸지 않는다
- 성공/실패 모두 `AuditService.log({ event: 'ingest_daemon_start'|'stop'|'restart', actorId: req.user.sub, detail: {...} })`

---

## 5. 영향받는 파일

| 파일 | 변경 |
|---|---|
| `server/src/services/ingestDaemonControl.js` | 신규 — start/stop/restart 핵심 로직 (기존 3개 스크립트에서 추출) |
| `server/src/scripts/startIngestDaemon.js`/`stopIngestDaemon.js`/`restartIngestDaemon.js` | 리팩터링 — `ingestDaemonControl.js` 호출하는 얇은 CLI 래퍼로 축소 |
| `server/src/routes/admin.js` | `POST /ingest/start`, `/ingest/stop`, `/ingest/restart` 3개 라우트 추가 |
| `client/src/components/IngestDaemonSection.tsx` | Start/Stop/Restart 버튼, 로딩/에러 상태, (Stop·Restart는 확인 모달 — 전 카메라 캡처 중단 영향) |
| `docs/mrd/`, `docs/rfp/`, `docs/prd/`, `docs/srs/`, `docs/tc/`, `docs/ops/` | 신규 문서 세트 |
| `test/api/ingest_daemon_control.test.js`, `TcRunnerService.js`, `test/tc_runner_cli.js` | 신규 테스트 스위트 |
| `.claude/skills/camera-stream-setup/SKILL.md`, `.github/skills/camera-stream-setup/SKILL.md` | Start/Stop/Restart API 언급 추가 |

---

## 6. 결정 사항 (2026-07-23 확정)

**Q1. 적용 범위 — 확정: Streaming + Combined 모드**
기존 모니터링 패널(`IngestDaemonSection`)의 가시성 규칙(`serverMode !== 'analysis'`)과 동일하게 맞춘다. 즉 combined 모드도 컨트롤 버튼을 사용할 수 있다. Analysis 모드는 카메라 캡처 자체가 없으므로 `CAPTURE_BACKEND !== 'ingest-daemon'`이 되어 자연히 제외된다(§2.3). API 게이팅은 `SERVER_MODE === 'analysis'` → 403이 아니라, **`CAPTURE_BACKEND !== 'ingest-daemon'` 단일 조건**으로 충분 — analysis 모드에서는 이 백엔드 자체를 안 쓰므로 이중 게이팅이 불필요.

**Q2. API 응답 모델 — 확정: 동기(A)**
HTTP 요청을 완료까지 유지하고 최종 결과(카메라별 재등록 성공/실패 등)를 응답 바디에 담는다. 기존 CLI 스크립트와 동일한 완료 보장 방식이며, `admin:ingest-stats`/`GET /api/ingest-status`는 버튼 클릭 없이도 상태를 계속 보여주는 보조 채널로 그대로 둔다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | §6 결정 확정(Q1: Streaming+Combined, Q2: 동기 응답) — Status를 Draft→Active로 전환, 구현 착수. `docs/mrd/`,`docs/rfp/`,`docs/prd/`,`docs/srs/`,`docs/tc/`,`docs/ops/` 문서 세트, TC 스위트, `ingestDaemonControl.js` 서비스 모듈, admin 라우트 3개, UI 버튼 구현 완료. |
| 0.1 | 2026-07-23 | 초기 작성 — 요구사항, 현재 상태 조사(기존 CLI 스크립트 재사용 가능성, `stopIngestDaemon.js` 좀비 오탐 버그 발견), 요청 항목 매핑, 아키텍처 초안, 미결정 사항 정리. 구현 미착수. |
