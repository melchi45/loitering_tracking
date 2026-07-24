# DESIGN DOCUMENT
# mediasoup 멀티 Worker 분리 — 단일 Worker 처리 병목 해소

| | |
|---|---|
| **Document ID** | DESIGN-LTS-WEBRTC-003 |
| **Version** | 2.0 |
| **Status** | Implemented |
| **Date** | 2026-07-22 |
| **Related Design** | [Design_RTSP_Capture_Backend.md](Design_RTSP_Capture_Backend.md) §6.30.2 (이 문서를 촉발한 실측 근거) |

---

## 1. 배경 — 왜 이 문서가 필요한가

`Design_RTSP_Capture_Backend.md` §6.30/§6.30.1/§6.30.2에서 5MP(2560×1920) 카메라의 WebRTC 재생이 반복적으로 정지되는 문제를 조사하던 중, 라이브 호스트에서 다음을 직접 확인했다:

- `/proc/net/snmp`의 `Udp: RcvbufErrors`가 15초 샘플링 간격으로 105건 증가(초당 ~7건) — **지금도 실시간으로 UDP 수신 버퍼 오버플로우가 발생 중**.
- `ss -u -a -n -p`로 mediasoup-worker(PID 확인, 단일 프로세스) 자신의 UDP 소켓을 조회한 결과, 일부 소켓의 Recv-Q(커널에 도착했지만 아직 worker가 읽지 못한 바이트)가 **최대 3.8MB**까지 쌓여 있었고, 3초 뒤 재조회에도 여러 소켓이 수백KB~3MB대를 유지.
- 이 시점 mediasoup-worker 자신의 CPU 사용률은 13~14%(호스트는 40코어, 전체 유휴 80%) — "CPU가 부족해서"가 아니라, 한 카메라(특히 대용량 키프레임을 짧은 시간에 쏟아내는 5MP 스트림)의 순간 처리가 다른 소켓의 읽기를 지연시키는 **단일 스레드 처리 순서 병목**으로 추정.

**핵심 사실**: 이 서버는 `mediasoupEngine.js:252`의 `mediasoup.createWorker()` 호출이 코드 전체에서 **단 1회**뿐이다 — 모든 카메라의 RTP 릴레이(ingest-daemon→mediasoup PlainTransport)와 모든 WebRTC 뷰어 트랜스포트가 이 하나의 싱글스레드 C++ 프로세스에 몰려 있다. mediasoup는 설계상 Worker 1개 = OS 스레드 1개이며, 공식 문서도 CPU 코어 수만큼 Worker를 띄워 부하를 분산하는 것을 표준 패턴으로 권장한다. 이 호스트는 40코어인데 실제로는 1개만 쓰고 있다.

§6.30.2에서는 즉시 적용 가능한 저위험 완화책(ingest-daemon 송신측 UDP 버퍼를 mediasoup 수신측과 대칭으로 8MB로 확장)만 우선 적용했고, 이 구조적 병목 자체는 손대지 않았다 — 사용자와 논의 후 "멀티 Worker 분리는 별도 설계 문서부터 시작"하기로 합의했다(2026-07-22).

---

## 2. 현재 구조 (코드 기준 확인)

### 2.1 Worker/Router 구성

- `_worker` (전역 단일 변수) — `mediasoup.createWorker({ logLevel: 'warn', rtcMinPort, rtcMaxPort })`, `_boot()` 함수 안에서 1회 생성.
- `_router` (전역 단일 변수) — `_worker.createRouter(...)`, 모든 카메라의 Producer/Consumer가 이 하나의 Router 위에 생성됨.
- **PT별 Router 캐시** (§6.26, `_altPipelines` 계열 — `mediasoupEngine.js:443` 부근) — Chrome이 협상하는 H.264 payload type이 기본 Router 설정과 다를 때(관측된 케이스: PT 108 vs 기본 96), **같은 Worker 위에** 대안 Router를 추가로 만들어 캐싱하는 기존 패턴이 이미 존재한다. 즉 "하나의 Worker 위에 여러 Router"는 이미 검증된 구조 — 이번 설계는 여기에 "여러 Worker"를 추가하는 확장이다.

### 2.2 카메라 → 트랜스포트 매핑

- `_cameras` (전역 `Map<cameraId, {...}>`) — `addCameraStream()`이 카메라별 video/audio `PlainTransport`+`Producer`, DirectTransport+DataProducer를 생성해 저장.
- `negotiate(cameraId, offer)` — 뷰어의 WHEP 협상 요청마다 `_cameras.get(cameraId)`로 Producer를 찾고, 같은 Router 위에서 `transport.consume({ producerId: videoProducer.id, ... })`로 Consumer를 만든다.

### 2.3 mediasoup의 핵심 제약 (설계를 좌우하는 사실)

- **Producer와 Consumer는 반드시 같은 Router 위에 있어야 한다.** 다른 Router에 있는 Producer를 Consume하려면 `router.pipeToRouter({ producerId, router: otherRouter })`로 먼저 파이프를 만들어 그 Router에 "복제 Producer"를 만들어야 한다 — 이는 추가 PlainTransport 페어와 메모리·CPU 오버헤드를 수반한다.
- **Router는 정확히 하나의 Worker에 속한다.** Worker를 넘나드는 Router는 없다 — 여러 Worker를 쓰려면 Worker마다 최소 1개의 Router가 필요하고, 그 Router들 사이의 코덱 협상 능력(`rtpCapabilities`)이 동일해야 한다(현재 `_buildRouterMediaCodecs()` 등 코덱 목록 생성 로직을 그대로 재사용 가능 — Worker별로 동일 설정의 Router를 만들면 됨).

---

## 3. 제안 아키텍처 옵션

### 옵션 A — 카메라 ID 해시 기반 정적 분산 (권장 후보)

- `numWorkers = os.cpus().length`(또는 상한을 둔 고정값, 예: 8) 만큼 Worker를 부팅 시 미리 생성, Worker마다 동일 설정의 기본 Router 1개(+필요시 PT별 alt-Router)를 준비.
- `addCameraStream(cameraId, ...)` 시점에 `hash(cameraId) % numWorkers`로 담당 Worker/Router를 결정 — 그 카메라의 Producer, 그리고 그 카메라를 보는 모든 뷰어의 Consumer가 전부 같은 Router 위에 생성됨(제약 §2.3 자동 충족, `pipeToRouter` 불필요).
- **장점**: 구현이 비교적 단순, 기존 `_cameras` Map을 `Map<cameraId, {..., workerIndex, router}>`로 확장하는 정도로 대응 가능. 카메라별 부하가 Worker 전반에 고르게 흩어짐(해시 기반이므로 카메라 수가 많아질수록 자연히 균등화).
- **단점**: 특정 시점에 "무거운 카메라"(5MP 등)들이 우연히 같은 Worker로 해시될 수 있음 — 완벽한 부하 균형은 아님. 카메라 추가/삭제가 잦으면 해시 분포가 미묘하게 틀어질 수 있음(다만 이 프로젝트는 카메라 수가 안정적으로 유지되는 편이라 실무 영향은 제한적일 것으로 예상).

### 옵션 B — 동적 최소부하 할당

- 카메라 등록 시 각 Worker의 현재 처리 카메라 수(또는 mediasoup가 제공하는 `worker.getResourceUsage()` 등 실측 지표)를 비교해 가장 한가한 Worker에 배정.
- **장점**: 이론적으로 더 균등한 부하 분산.
- **단점**: 상태 추적(Worker별 카메라 수·부하 지표) 로직이 추가로 필요, 재시작/재배정 시나리오(카메라 삭제 후 재등록 등)에서 일관성 유지가 옵션 A보다 복잡. "부하"를 무엇으로 측정할지(카메라 수 단순 카운트 vs 해상도 가중치 vs 실측 CPU) 자체가 별도 결정 사항.

### 옵션 C — 보류, 현재 구조 유지하며 추가 계측만 진행

- §6.30.2의 송신측 버퍼 확장 효과를 먼저 관찰(RcvbufErrors 증가율이 유의미하게 줄어드는지)한 뒤, 여전히 문제가 남을 때만 멀티 Worker로 진행.
- **장점**: 큰 구조 변경 없이 저위험 조치의 효과를 먼저 검증.
- **단점**: 근본적으로 싱글스레드 병목 자체는 남아있어, 카메라 수가 늘어나면 언젠가 다시 한계에 부딪힐 가능성이 높음.

---

## 4. 영향받는 코드 (구현 시 손대야 할 범위, 참고용 — 아직 구현 안 함)

- `mediasoupEngine.js`: `_boot()`(Worker 풀 생성), `_ensureRouter()`(카메라별 Router 결정 로직으로 재작성), `_cameras` Map 스키마(workerIndex/router 필드 추가), `addCameraStream()`/`removeCameraStream()`(담당 Worker 결정·해제), `negotiate()`(Consumer를 카메라가 속한 Router에서 생성하도록 이미 구조상 자연히 맞춰짐), `_worker.on('died', ...)` 핸들러(현재 단일 Worker 가정 — 풀의 개별 Worker 사망 시 그 Worker가 담당하던 카메라만 복구하도록 범위 축소 필요).
- PT별 alt-Router 캐시(§6.26): Worker마다 독립적으로 유지해야 함(현재 전역 1개 캐시 → Worker별 캐시로 확장).
- `GET /api/webrtc/monitor`, Admin Dashboard Ingest Daemon 패널(`ingestStatsAggregator.js`) 등 mediasoup 상태를 조회하는 기존 엔드포인트들이 "단일 Worker" 가정을 하고 있는지 점검 필요(현재는 `getProducerStats()` 등이 전역 `_cameras`를 순회하는 구조라 Worker가 여러 개여도 카메라 단위 조회 자체는 영향 없을 가능성이 높으나, 확인 필요).

---

## 5. 열린 질문 (구현 전 확정 필요)

1. **Worker 개수**: `os.cpus().length`(40) 그대로 쓸지, 카메라 대수 대비 과도한지 판단해 상한(예: 8~16)을 둘지 — 이 프로젝트의 통상 동시 등록 카메라 수(§6.29.14 인시던트 기준 정상 범위는 한 자릿수~10대 초반, 사고 시 34대까지 폭증한 전례 있음) 대비 적정선 결정 필요.
2. **분산 전략**: §3의 A(해시)/B(동적 최소부하) 중 선택 — 우선 A로 시작하고 필요 시 B로 고도화하는 단계적 접근도 가능.
3. **PT별 alt-Router 캐시**(§6.26)를 Worker별로 어떻게 유지할지 — 전역 1개였던 캐시를 Worker마다 복제할지, 아니면 다른 자료구조로 재설계할지.
4. **Worker 장애 시 복구 범위** — 현재 `_worker.on('died', ...)`는 "전체 카메라 재등록"을 전제로 작성되어 있음(전역 Worker가 하나였으므로). 멀티 Worker에서는 죽은 Worker가 담당하던 카메라만 복구해야 스코프가 맞음 — 복구 로직 재작성 필요.
5. **관측/모니터링**: Worker별 부하(카메라 수, CPU, Recv-Q 등)를 Admin Dashboard에 노출할지 — §6.30.2의 근본 원인 진단에 `ss`/`/proc/net/snmp` 수작업 조회가 필요했던 점을 감안하면, 향후 유사 문제 재발 시 빠른 진단을 위해 Worker별 지표를 상시 노출하는 가치가 있어 보임(범위 포함 여부는 사용자 결정).
6. **롤아웃 방식**: 기존 실행 중인 카메라들을 무중단으로 재분산할지, 아니면 다음 재시작부터 자연스럽게 새 구조로 전환할지(카메라 재등록 자체가 그리 무겁지 않은 작업이므로 후자가 더 단순해 보이나, 확정 필요).

---

## 6. 구현 결과 (2026-07-22)

사용자가 옵션 A(카메라 ID 해시 기반 정적 분산)로 즉시 구현을 요청 — §5의 열린 질문에 대해 다음 기본값으로 진행:

1. **Worker 개수**: `min(os.cpus().length, 8)` — `MEDIASOUP_NUM_WORKERS` 환경변수로 재정의 가능(이 호스트에서는 8로 명시 설정, `server/.env`/`.env.example` 3종에 문서화 완료).
2. **분산 전략**: 옵션 A(해시) 채택 — `cameraId` 문자열의 단순 다항 해시(`h = h*31 + charCode`) → `Math.abs(h) % NUM_WORKERS`.
3. **PT별 alt-Router 캐시**(§6.26): `_ptRouters` Map의 키를 `videoPt` 단독에서 `"workerIndex:videoPt"` 복합 키로 확장 — Worker별 독립 캐시.
4. **Worker 장애 복구 범위**: `_handleWorkerDied(index)`로 축소 — 죽은 Worker가 담당하던 카메라만 `_cameras`에서 제거·재등록, 다른 Worker의 카메라는 영향받지 않음(기존 싱글톤은 Worker 1개 죽으면 전체 카메라 리셋).
5. **관측/모니터링**: `getEngineInfo()`에 `numWorkers` 필드만 우선 추가 — Worker별 상세 지표(카메라 수/CPU/Recv-Q) 노출은 범위 밖으로 남김(후속 과제).
6. **롤아웃**: 재시작 시 자연 전환 — 카메라들이 `addCameraStream()`을 통해 재등록되며 새 해시 배정을 받음. 무중단 재분산은 구현하지 않음.

**코드 변경**: `server/src/services/webrtc/mediasoupEngine.js` — 전역 `_worker`/`_router` 싱글턴을 `_workerPool[]`(배열, 각 slot = `{worker, router}`)로 교체. `_ensureRouter(cameraId)`가 해시로 slot을 찾아 반환, `_ensureWorkerSlot(index)`가 slot별 in-flight 빌드를 가드(동시성 안전), `_cameras` 엔트리에 `workerIndex` 필드 추가(addCameraStream() 시점 1회 계산해 저장 — negotiate()/alt-pipeline은 재해시하지 않고 저장된 값을 그대로 사용, Producer/Consumer가 반드시 같은 Router에 있어야 하는 mediasoup 제약을 충족하기 위함).

**검증**:
- `node -c` 문법 체크, 독립 `require()` 스모크 테스트로 8-Worker 풀 정상 부팅(`isHealthy()` true) 및 카메라 5개가 여러 Worker(해시로 2/6/2/6/6번)에 분산 배정됨을 확인.
- (스모크 테스트 중 실수로 실제 ingest-daemon에 테스트용 가짜 카메라 5개가 등록됐던 것을 발견 즉시 `DELETE`로 정리 — DB에는 영향 없었음을 확인.)
- 실제 운영 서버(`npm run stop` → `npm run start`)에 배포, 로그에서 `[WebRTC][mediasoup] ready workers=8 ...` 확인. 재시작 직후 `GET /api/webrtc/monitor`로 전체 카메라 `running:true`/`useWebRTC:true` 정상 복구 확인.
- 배포 후 첫 ~3분간 `GET /api/client-logs`로 관측한 결과: `framesDecoded stuck` 로그가 8건 발생했으나 대부분(6/8) YouTube 스트림(`yt-9bb39`, 별개의 캡처 백엔드·원인)이었고, 문제의 5MP 카메라(`61813f62`)는 1건뿐(그마저도 `stuck at 404`·`bytesReceived=42MB`로 이전의 "stuck at 0" 패턴보다 훨씬 건강한 상태에서 발생) — `4e562747`은 이 관측 창에서 0건. 표본이 작아(3분) 단정할 수 없으나 초기 신호는 긍정적. 장시간 관측 및 §6.29.14 재발 패턴(사용자 확인)이 후속 과제.

## 7. 후속 — Worker 프로세스 스케줄링 우선순위 (2026-07-22)

배포 몇 분 뒤 사용자가 다른 고해상도 카메라(`61813f62`, 2048×1536)에서 재현 보고(Loss 13.7%, Frames 22 decoded). 실측 결과, 이 카메라는 해시 배정상 Worker를 **단독 사용**(경합 없음)인데도 그 Worker CPU가 2.9~4.7%뿐인 채로 Recv-Q가 MB 단위로 적체됨을 확인 — "Worker 개수 부족"이 아니라 **CPU 통계엔 안 잡히는 순간적 스케줄링 지연**(27명이 쓰는 공유 호스트)이 원인일 가능성으로 진단이 이동했다.

### 7.1 1차 시도 — 실패 (권한 경계 착오)

`_bootWorkerSlot()`에서 `os.setPriority(worker.pid, -5)`를 Node 메인 프로세스(부모) 안에서 자식(mediasoup-worker)의 pid를 대상으로 직접 호출, `sudo setcap cap_sys_nice+ep`를 **mediasoup-worker 바이너리**에 부여. 재시작해도 모든 Worker에서 `EACCES` 재현 — `setpriority()`로 **다른 프로세스**의 우선순위를 올릴 때 커널이 검사하는 건 **호출자(caller)의 capability**이지 대상(target)의 것이 아니라는 걸 놓쳤다. 캡을 준 바이너리(mediasoup-worker)가 아니라, 실제로 syscall을 호출하는 바이너리(Node)에 캡이 필요했던 것.

### 7.2 2차 시도 — Linux 전용 self-elevating exec 래퍼로 해결

`tools/mediasoup-worker-priority-wrapper/`에 작은 C 바이너리(`wrapper.c`) 신규 추가 — (1) 자기 자신에 `CAP_SYS_NICE`를 받고, (2) `execve()` 이후 **자기 자신**을 대상으로 `setpriority()`를 호출(self-targeting이므로 이번엔 호출자=대상이 일치, 캡이 제대로 적용됨), (3) 실제 mediasoup-worker로 `execv()` 체인 — 프로세스의 nice 값은 `execve()`를 넘어도 유지되므로, 실제 mediasoup-worker는 캡 없이도 이미 올라간 우선순위를 그대로 물려받는다.

- `CMakeLists.txt`로 빌드 — **Linux 전용**(`UNIX AND NOT APPLE`), Windows/macOS는 의도적으로 빌드 스킵:
  - Windows: `os.setPriority()`(Win32 `SetPriorityClass`)가 자식 프로세스에 대해 별도 권한 없이 `HIGH_PRIORITY_CLASS`까지 허용 — 기존 부모측 직접 호출(1차 시도 코드)이 그대로 충분해 래퍼 자체가 불필요.
  - macOS: Linux capabilities에 대응하는 비-root 메커니즘이 없어(결국 root 필요) 래퍼를 만들어도 이득이 없음 — graceful 폴백(경고 후 기본 우선순위로 계속)으로 충분.
- **빌드 스크립트**: `server/src/scripts/buildMediasoupWorkerWrapper.js`(`npm run build:mediasoup-wrapper`, 루트/`server/` 양쪽에서 사용 가능) — cmake/gcc 존재 확인 후 configure+build+install까지 원스텝 실행, Windows/macOS에서는 이유를 설명하고 아무것도 빌드하지 않은 채 정상 종료. 다른 환경(예: 다른 Linux 개발 머신)에서도 이 스크립트 하나로 동일하게 재현 가능.
- `mediasoupEngine.js`는 부팅 시 래퍼 바이너리 존재 여부(`_WRAPPER_AVAILABLE`)를 감지 — 있으면 `mediasoup.createWorker({ workerBin: <래퍼 경로> })`로 mediasoup 자체가 래퍼를 spawn하도록 하고 `MEDIASOUP_WORKER_REAL_BIN`/`MEDIASOUP_WORKER_PRIORITY` 환경변수로 래퍼에 필요한 정보 전달(래퍼는 mediasoup이 생성한 나머지 인자를 그대로 실제 바이너리에 전달) — 없으면 1차 시도의 부모측 직접 호출로 폴백(Windows에선 이 경로가 정상 동작, Linux/macOS에서 래퍼 미빌드 시엔 기존과 동일하게 경고 후 무해하게 스킵).

**검증**: `sudo setcap cap_sys_nice+ep <래퍼 바이너리>` 적용 후 래퍼 단독 실행 테스트(`MEDIASOUP_WORKER_REAL_BIN=/bin/sleep ... wrapper 5 &`)로 자식 프로세스 `NI=-5` 직접 확인. `npm run stop`→`start`로 실서버 재배포 후 `ps -o pid,ni,cmd`로 8개 mediasoup-worker 전부 `NI=-5` 확인 완료. 실제 손실률 개선 여부는 장시간 관측 필요(후속 과제) — 이 조치로도 해결 안 되면 원인 1(RTCP PLI 경로 부재, `Design_RTSP_Capture_Backend.md` §6.30/§6.30.1)로 넘어가야 한다는 결론은 유효.

## 8. Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 3.0 | 2026-07-22 | §7 신규 — Worker 스케줄링 우선순위 조치. 1차 시도(부모측 직접 `os.setPriority()` + mediasoup-worker 바이너리에 setcap) 실패 원인(호출자 vs 대상 capability 착오) 기록, 2차 시도(self-elevating exec 래퍼, `tools/mediasoup-worker-priority-wrapper/` 신규 + `npm run build:mediasoup-wrapper` 빌드 스크립트, Linux 전용/Windows·macOS는 불필요·불가능 이유 명시)로 해결·검증(전 Worker NI=-5 확인) |
| 2.0 | 2026-07-22 | §6 신규 — 사용자 요청으로 즉시 구현. 열린 질문 6건에 대한 결정 사항 기록, 코드 변경 요약, 검증 결과(스모크 테스트+실배포+초기 3분 관측) 추가. Status: Draft → Implemented |
| 1.0 | 2026-07-22 | 초기 작성 — §6.30.2 실측 근거를 바탕으로 문제 정의, 현재 구조·mediasoup 제약 정리, 옵션 A/B/C 제시, 열린 질문 6건 명시. 구현 전 상태 |
