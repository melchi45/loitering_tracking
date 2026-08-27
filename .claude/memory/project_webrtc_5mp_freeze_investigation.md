---
name: project-webrtc-5mp-freeze-investigation
description: "5MP(2560×1920) 카메라 WebRTC 재생 정지 조사 — mediasoup 멀티워커/스케줄링 개선 구현 완료, 급성 '재생 완전 불가'의 진짜 원인은 ingest-daemon 다운으로 최종 확정·복구 (2026-07-22)"
metadata:
  type: project
  originSessionId: 23271567-dba0-4ffb-98f5-ab031d3bf1f0
  modified: 2026-07-22T07:26:19.599Z
---

2026-07-22, 5MP(2560×1920) 카메라의 WebRTC 재생이 반복적으로 정지되는 문제를 깊이 조사해 두 가지 독립적인 근본 원인을 확정했다. 상세 근거·수정 내역은 `docs/design/Design_RTSP_Capture_Backend.md` §6.30/§6.30.1/§6.30.2, 멀티워커 설계는 `docs/design/Design_Mediasoup_Multi_Worker.md`.

**원인 1 — RTCP PLI 경로가 구조적으로 없음**: `ingest_daemon.py`는 카메라→mediasoup으로 RTP만 한 방향 릴레이할 뿐 RTCP 처리 코드가 전혀 없다. 키프레임이 유실되면 브라우저가 보내는 PLI(키프레임 재요청)도, `mediasoupEngine.js`의 `videoConsumer.requestKeyFrame()`도 실제 카메라까지 도달할 방법이 없어, 복구가 전적으로 카메라 자체의 다음 예정 키프레임 타이밍에 의존한다.

**원인 2 — mediasoup 단일 Worker가 실시간으로 UDP 패킷을 못 따라감 (실측 확정)**: `/proc/net/snmp`의 `Udp.RcvbufErrors`가 초당 ~7건씩 실시간 증가, `ss -u -a -n -p`로 mediasoup-worker 자신의 UDP 소켓 Recv-Q가 최대 3.8MB까지 쌓여있음을 직접 확인 — 이 서버는 `mediasoup.createWorker()`를 코드 전체에서 단 1회만 호출(40코어 중 1개만 사용), 모든 카메라의 RTP 릴레이+WebRTC 트랜스포트가 하나의 싱글스레드 프로세스에 몰려 있다. Worker 자체 CPU는 13~14%(호스트 유휴 80%)로 CPU 부족이 아니라 처리 순서/버스트 병목으로 추정.

**적용한 fix (2026-07-22)**:
- `client/src/hooks/useWebRTC.ts`의 통계 패널 fps를 브라우저 raw `framesPerSecond`(신뢰 못함) 대신 `framesDecoded` 델타 기반 자체 계산으로 변경 — §buffer-oscillation과 동일 패턴.
- `ingest_daemon.py`의 RTP 송신 소켓 4곳(video×2, audio×2)에 `buffer_size=8MB` 옵션 추가 — mediasoup 수신측(§6.18에서 이미 8MB)과 대칭. `ingest:restart`로 배포 완료.

**진단 방법 팁 (재사용 가능)**: 사용자가 "재연결이 전혀 안 된다"고 체감 보고했지만, `GET /api/client-logs`(인증 불필요)로 실제 브라우저 콘솔 로그를 직접 조회해 프레임 스톨 워치독이 78분간 104회, 25~45초 간격으로 실제로는 계속 재연결 시도 중이었음을 확정 — 사용자 체감과 실제 로그가 다를 수 있으니 이런 류의 "멈춰있다"는 보고는 `/api/client-logs` 조회로 먼저 검증할 것. `ss -u -a -n -p`(소켓별 Recv-Q)와 `/proc/net/snmp`의 `Udp:` 라인(RcvbufErrors/SndbufErrors, 두 번 샘플링해 증가율 확인)이 mediasoup/ingest-daemon UDP 릴레이 문제 진단에 유용.

**mediasoup 멀티 Worker 분리 — 같은 날 구현 완료 (2026-07-22)**: 사용자가 즉시 구현을 요청, `mediasoupEngine.js`의 전역 `_worker`/`_router` 싱글턴을 8-Worker 풀(`MEDIASOUP_NUM_WORKERS`, 기본 `min(cpu, 8)`)로 교체 — 카메라는 cameraId 해시로 결정적으로 Worker에 배정(`_cameras.workerIndex`), §6.26의 PT별 alt-Router 캐시도 Worker별 분리, Worker 장애 복구 범위도 죽은 Worker의 카메라만으로 축소. `server/.env`/`.env.example` 3종에 문서화(`8`로 명시 설정). 실서버에 `npm run stop`→`start`로 배포, 전체 카메라 정상 복구 확인. 상세 설계·검증 결과는 `docs/design/Design_Mediasoup_Multi_Worker.md`(v2.0, Implemented), 요약은 `Design_RTSP_Capture_Backend.md` §6.31.
- **배포 중 사고 노트**: 독립 스모크 테스트(`node -e`로 모듈 직접 require)가 실제 운영 중인 ingest-daemon(포트 7070)에 가짜 테스트 카메라 5개를 실제로 등록시킴(모듈이 `INGEST_DAEMON_URL` 기본값으로 진짜 localhost daemon을 가리키기 때문) — 즉시 발견해 `DELETE /cameras/:id`로 정리, DB에는 영향 없었음. **앞으로 이 프로젝트에서 mediasoupEngine.js/ingest_daemon.py 관련 스모크 테스트를 할 때는 실제 ingest-daemon이 떠 있는 채로 독립 스크립트를 돌리면 진짜 카메라 등록이 발생할 수 있다는 것을 기억할 것.**
- **초기 검증(3분 관측)**: 문제의 5MP 카메라(`61813f62`) 스톨 1건(이전보다 훨씬 건강한 상태에서 발생, `bytesReceived=42MB`/`framesDecoded stuck at 404`), `4e562747` 0건 — 표본이 작아 단정 불가, 장기 관측 필요.

**멀티 Worker 배포 후 재현 — 원인 재조정 (2026-07-22, 같은 날 후속)**: 배포 몇 분 뒤 다른 고해상도 카메라(`61813f62`, 2048×1536)에서 재현(Loss 13.7%, Frames 22 decoded). 실측으로 확정: 이 카메라는 해시 배정상 Worker를 **단독 사용**(다른 카메라와 경합 없음)인데도 그 Worker의 CPU는 2.9~4.7%뿐이면서 Recv-Q가 여전히 MB 단위로 적체됨 — "Worker 개수 부족"이 아니라 **공유 호스트(27명 로그인, load avg 10~15/40코어)의 순간적 스케줄링 지연**이 원인일 가능성으로 무게중심 이동(CPU 총사용량엔 안 잡히는 종류의 지연). `renice` 직접 시도 결과 `Permission denied` 확인(`ulimit -e`=0, CAP_SYS_NICE 없음).
- **조치**: `mediasoupEngine.js` `_bootWorkerSlot()`에 `os.setPriority(worker.pid, -5)` 추가(`MEDIASOUP_WORKER_PRIORITY`로 조정 가능) — 권한 없으면 경고만 남기고 무해하게 스킵. **사용자가 직접 실행해야 하는 명령**: `sudo setcap cap_sys_nice+ep /data6/youngho/workspace/loitering_tracking/server/node_modules/mediasoup/worker/out/Release/mediasoup-worker` (이 세션은 비대화형이라 sudo 직접 실행 불가 — 실행 후 서버 재시작 필요). 상세는 `Design_RTSP_Capture_Backend.md` §6.31.1.
- **이 조치로도 해결 안 되면**: 결국 원인 1(RTCP PLI 경로 부재)로 돌아가야 함 — 손실 자체를 줄이는 것보다 손실 후 빠른 복구(카메라 GOP 단축/PLI 구현)가 근본 해법이라는 처음 진단이 재확인되는 셈.

**최종 결말 — 급성 "재생 완전 불가" 증상의 진짜 원인은 ingest-daemon 다운 (2026-07-22, 같은 날 최종)**: 스케줄링 우선순위 조치(래퍼) 배포 후에도 사용자가 "영상이 아예 안 나온다"(Loss 76.6%, Codec 완전 공백, Frames 0)고 반복 보고. NIC 링버퍼 확장(사용자 sudo로 적용, `ethtool -G eth1 rx 4096`)도 drop률을 개선하지 못해 진단 방향을 재점검하던 중, `GET /api/webrtc/monitor`의 서버측 producerStats를 직접 조회해 mediasoup Producer가 실제로는 **완벽**(score 10, 수백MB 정상 수신)함을 발견 — 그동안의 "손실률" 중심 진단이 잘못된 방향이었을 가능성 포착. `LTS_DEBUG_SDP=true`로 SDP를 직접 찍어보려다 로거의 `\bdebug\b` 자동 강등 휴리스틱(`[SDP-DEBUG]` 태그명 자체가 하이픈 경계로 "debug" 단어 매치)에 걸려 `LOG_LEVEL=INFO`에서 조용히 필터링되는 것을 발견 → `LOG_LEVEL=DEBUG`로 전환 재시작 후 진짜 원인 확정: **ingest-daemon이 조사 도중 완전히 다운**(`ECONNREFUSED :7070`, 재등록 로그에 video RTP 포트 자체가 빠짐 `[AI+appRTP]`만). 이번 세션 후반부 "0프레임" 급성 증상 대부분은 mediasoup/Worker 튜닝과 무관하게 ingest-daemon 다운이 직접 원인 — `npm run ingest:restart`로 복구, 3개 카메라 전부(730~880+프레임까지 계속 증가) 정상 디코딩 재개 실측 확인.
- **다운 원인은 미확정** — 이 세션에서 반복한 짧은 간격의 서버 재시작·`/stream/reconnect` 트리거가 ingest-daemon에 누적 부하를 줬을 가능성 높음(§6.29.5/§6.29.9의 기존 "반복적 응답 불능" 미해결 문제와 같은 계열일 수 있음).
- **진단 교훈**: 이런 다계층 증상은 mediasoup 통계만 보지 말고 **`curl :7070/health`로 ingest-daemon 생존부터 먼저 확인**할 것 — 이번엔 몇 시간의 조사 중 상당 부분이 "이미 다운된 daemon에 대고 계속 재시도하는 것"을 관측한 셈이었다.
- 로거의 `debug` 단어 자동 강등 휴리스틱(`makeLineRelay()`)이 `[SDP-DEBUG]`처럼 태그 이름에 "debug"가 포함된 진단 로그를 `LOG_LEVEL=INFO`에서 조용히 삼켜버리는 것도 재사용 가능한 교훈 — 앞으로 새 진단 로그 태그를 지을 때 "debug"라는 단어 자체를 피하거나, 확인 시 `LOG_LEVEL=DEBUG`가 필요함을 기억할 것.

**세 번째 재발 — 두 가지 개별 사소한 원인으로 확정 (2026-07-22, 같은 날 재최종)**: §6.31.2 복구 후 재차 "영상 안 나옴" 보고. 이번엔 서버·ingest-daemon 둘 다 healthy(daemon 다운 아님)임을 먼저 확인. `LTS_DEBUG_SDP`를 `console.log` 대신 `fs.appendFile()`로 직접 파일(`<repo-root>/sdp-debug.log`) 기록하도록 고쳐 로거의 debug-강등 문제를 근본 회피 — 실제 SDP는 문제 없었고, 재시작 자체가 "나쁜 상태에 갇힌 PeerConnection"을 정리하며 정상화(재발이 사실은 코드 결함이 아니라 §6.30/6.30.1의 "손실 후 복구 경로 부재" 문제의 또 다른 발현으로 추정). 개별 원인 2건: (1) `61813f62` 물리 카메라가 일시적으로 RTSP 연결 거부(카메라측, 코드 무관, 스스로 복구됨), (2) `yt-9bb39`는 YouTube URL 갱신 재시도(§6.16 기존 이슈)와 브라우저 협상 타이밍이 겹쳐 지연 fan-out 등록이 82초 지연됨.
- **중요 진단 팁**: `npm run start`(전체 스택)로 띄우면 ingest-daemon 로그가 `/tmp/ingest-daemon.log`가 아니라 **메인 통합 로그(`server/logs/lts-*.log`)의 `[Ingest]` 접두사**로 들어간다 — `npm run ingest:restart` 단독 실행 시에만 `/tmp/ingest-daemon.log` 사용. 두 경로를 혼동하면 몇 시간 전 stale 로그를 최신인 줄 알고 오진할 수 있음(이번에 실제로 겪음).

**미해결/진행 중**:
- "Ctrl+Shift+R 새로고침 후 Codec 정보가 `-`" 증상은 §6.27의 기존 `profileLevelId` 캐시 고착 가설과 이번 릴레이 손실 가설이 둘 다 설명 가능해 원인 미확정 — 여러 차례의 재시작(`ingest:restart`, 그리고 이번 `npm run stop`/`start`)이 두 원인 후보를 모두 리셋시켰으므로 재현 여부 재확인 필요.
- 원인 1(PLI 경로 부재)의 근본 수정(카메라 GOP 단축/RTCP PLI 포워딩 구현)은 아직 미결정 — 사용자 결정 대기 상태.
- 멀티 Worker 배포 후 장시간(수 시간~하루 이상) 안정성 관측이 아직 없음 — 재발 여부 확인 필요.
