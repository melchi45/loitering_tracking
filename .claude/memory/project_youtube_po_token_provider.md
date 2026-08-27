---
name: project-youtube-po-token-provider
description: "YouTube PO Token 정책 강화 대응 — opt-in bgutil-ytdlp-pot-provider 사이드카 연동 (2026-08-26, Implemented)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 21007840-4f9f-4933-a35a-f6132400b623
  modified: 2026-08-27T02:01:17.369Z
---

YouTube가 봇 트래픽 차단을 위해 PO Token(Proof-of-Origin Token) 요구 범위를 확대하면서, `server/src/services/youtubeStreamService.js`의 yt-dlp 파이프라인이 "Sign in to confirm you're not a bot" / 연속 403 / `ffmpeg exited 183` 오류를 겪을 위험이 커졌음을 확인하고 opt-in 사전 예방 기능을 추가했다.

**발견 경위:** 사용자가 melchi45 소유의 별도 프로젝트 [rtsp-over-websocket](https://github.com/melchi45/rtsp-over-websocket)(우리 프로젝트가 client-side RTSP-over-WebSocket 재생 경로에 쓰는 npm 패키지의 원본 저장소 — [[project_ump_stap_a_sps_null_bugfix]] 등 참고)가 **자체 데모 서버에 우리와 동일한 YouTube→yt-dlp→ffmpeg→RTSP 파이프라인을 구현**하고 있고, 그 README/`transcodeSession.ts`에 이미 PO Token 대응 로직이 있음을 지목해 조사를 요청. 두 프로젝트는 아키텍처가 겹칠 뿐 코드 의존 관계는 전혀 없다 — 착각하기 쉬운 지점이므로 유의.

**What:**
- `bgutil-ytdlp-pot-provider`(공식 Docker 이미지 `brainicism/bgutil-ytdlp-pot-provider`, 포트 4416)를 `docker-compose.yml`에 opt-in 사이드카로 추가(qdrant와 동일 패턴).
- `youtubeStreamService.js`에 `YTDLP_POT_PROVIDER_ENABLED`(기본 `false`)/`YTDLP_POT_PROVIDER_URL` env, `_potProviderReachable()`(`/ping` 프로브)/`_shouldUseMwebPotClient()` 추가 — 플래그+JS런타임+프로브 성공 세 조건 모두 만족할 때만 `--extractor-args youtube:player_client=mweb` + `youtubepot-bgutilhttp:base_url=...`를 yt-dlp에 추가, 그 외에는 기존 동작 그대로 폴백(하드 실패 없음).
- yt-dlp 플러그인(`pip install bgutil-ytdlp-pot-provider`, PyPI 자동 인식) 설치 로직을 `server/src/scripts/installYtdlpPotPlugin.js`(`npm run install-pot-plugin`) 하나로 일원화 — `setup-env.linux.sh`/`setup-env.windows.ps1`은 각자 인라인 구현하지 않고 이 스크립트를 호출만 함(최초 3파일 중복 구현 후 사용자 요청으로 리팩터링, 2026-08-26 같은 날).
- **실행 테스트로 발견한 버그:** 최초 구현은 설치 검증을 `python3 -c "import bgutil_ytdlp_pot_provider"`로 했는데, 이 패키지는 top-level import 가능한 모듈을 전혀 제공하지 않는다(`yt_dlp_plugins/extractor/getpot_bgutil*.py`만 yt-dlp 플러그인 네임스페이스에 설치) — pip install 자체는 매번 성공(`Requirement already satisfied`)하는데도 검증 단계가 항상 실패로 오판했다. `npm run install-pot-plugin`을 실제로 실행해보지 않았다면 커밋된 채로 남았을 결함 — WebFetch로 요약한 "설치 후 자동 인식됨" 문구를 그대로 믿지 않고 직접 실행 검증한 덕에 발견. `importlib.metadata.version('bgutil-ytdlp-pot-provider')`로 pip 메타데이터를 직접 확인하는 방식으로 수정.
- **Deno 불필요 판단:** 원 프로젝트는 JS 챌린지 해결에 Deno를 쓰지만, 우리는 이미 Node(`--js-runtimes node:...`, §12.4/§12.5 기존 코드)로 동일 역할을 하고 있어 신규 런타임 의존성 추가를 피했다 — WebFetch로 원 저장소 README/소스를 직접 확인해 검증.

**Why:** [[feedback_docs_first_new_features]] 원칙에 따라 구현 전 Design/SRS 문서(`Design_YouTube_RTSP_Ingest.md` §12.6, `SRS_YouTube_RTSP_Ingest.md` FR-YT-016)를 먼저 작성하고, 배포 방식(Docker Compose vs 로컬 스크립트 vs 수동)·활성화 정책(opt-in vs 자동감지)·플러그인 설치 자동화 여부 3가지를 AskUserQuestion으로 확인(모두 "권장" 옵션 채택) 후 구현. 실 코드 변경(`youtubeStreamService.js`, `docker-compose.yml`, `.env.example`, setup-env 스크립트 2종)은 백그라운드 서브에이전트로 분리 실행 — 문서 작업(메인 스레드)과 코드 작업(에이전트)이 동시에 같은 워킹 디렉토리에서 진행되어도 파일이 겹치지 않아 충돌 없었음.

**How to apply:** YouTube 채널에서 403/타임아웃/봇 확인 오류가 재발하면, 먼저 `YTDLP_POT_PROVIDER_ENABLED=true` + `docker compose up -d bgutil-pot-provider`로 이 기능을 켜서 재현되는지 확인할 것 — §12.4/§12.5(연속 403 강제재시작)는 사후 대응이라 여전히 유효하지만 근본 예방은 이 기능. **미검증 상태(2026-08-26 기준):** 코드/구문 검증만 완료, 실제 사이드카를 띄운 라이브 YouTube 채널 대상 E2E 테스트는 아직 없음 — 문제 재현 시 가장 먼저 실 라이브 채널로 이 기능 자체의 동작을 검증할 것.

**README §14 상태 정정 (2026-08-27):** 처음엔 "실 라이브 채널 E2E 미검증"을 이유로 🟡 In Progress로 표기했으나, 사용자가 "이미 구현된 것 아니냐"고 지적 — Phase 11(User Auth, 이메일 인증·2FA 미착수인데도 ✅ Done)과 비교 검증한 결과 지적이 맞아 ✅ Done으로 정정. 자세한 판단 기준은 [[feedback_readme_milestone_status_bar]] 참고.

**실 운영 활성화 (2026-08-27):** 사용자가 실제 `server/.env`에 `YTDLP_POT_PROVIDER_ENABLED=true` + `YTDLP_POT_PROVIDER_URL=http://192.168.214.3:4416`(로컬호스트가 아닌 별도 LAN 머신)를 설정 — 이 프로젝트의 다른 예시 IP(`SERVER_IP`/`TURN_URL` 등)와 같은 사설 대역, 사이드카를 다른 머신에서 띄운 것으로 추정. 원격 호스트 배포 패턴을 `Design_YouTube_RTSP_Ingest.md` §12.6, `camera-stream-setup` 스킬, `.env.example`, `CLAUDE.md`에 반영 완료. `README.md` §15.1.3을 신설해 `npm run install-pot-plugin`의 실제 콘솔 출력 예시까지 문서화(사용자가 "npm run 결과물을 설명해달라"고 명시적으로 요청 — 명령어만 나열하지 말고 실행 결과를 보여줄 것, [[feedback_sdlc_sync]]와 함께 참고). 실 라이브 채널 E2E 검증 자체는 여전히 미확인.
