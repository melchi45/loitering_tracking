# OPERATIONS GUIDE
# AI Age Estimation — Setup & Cross-Server Diagnostics

| | |
|---|---|
| Document ID | OPS-AGE-001 |
| Version | 1.0 |
| Status | Active |
| Date | 2026-07-14 |
| Related Design | design/Design_AI_Age_Estimation.md |
| Related SRS | srs/SRS_AI_Age_Estimation.md |
| Related TC | tc/TC_AI_Age_Estimation.md |

---

## 1. 개요

Age Estimation은 opt-in AI 모듈로, 감지된 person의 연령을 추정한다(InsightFace GenderAge 또는 ViT Age Classifier 중 택1). 이 문서는 활성화 절차와, `SERVER_MODE=streaming`처럼 카메라 캡처 서버와 AI 추론 서버가 분리된 배포에서 "왜 화면에 안 보이는지" 진단하는 절차를 안내한다.

---

## 2. 활성화 절차

1. Admin Dashboard → AI Models → "Age Estimation" 섹션에서 두 모델 중 하나 Download → Activate
2. `PUT /api/analytics/config` (또는 Admin UI 토글)로 `ageEstimation: true` 설정
3. `combined`/`analysis` 모드는 즉시 로컬에서 추론 시작. `streaming` 모드는 원격 analysis 서버(`ANALYSIS_SERVER_URL`)에서 위 1-2단계가 수행되어야 함 — streaming 서버 자체는 모델을 로드하지 않는다.

## 3. 라인 플로우 요약

전체 프레임→화면 데이터 흐름(분기 포함 Mermaid 다이어그램)은 `Design_AI_Age_Estimation.md` §12를 참고. 요약:

```
카메라 프레임 → [streaming이면 HTTP로 analysis 서버에 위임] → 게이트(토글+모델ready)
  → person별 crop 선택(face 우선, 없으면 body) → 모델 추론 → {value,bucket?,source,modelId}
  → detectionTracks/detectionSnapshots 영속화 + Socket.IO 실시간 emit
  → 클라이언트 4곳 표시(CameraView 오버레이 / FullscreenCameraView 목록 / DetectionsTimelineInline 상세 / SearchFullscreen 검색결과)
```

## 4. 진단 절차 — "토글은 켰는데 화면에 안 보임"

### Step 1 — 로컬(지금 보고 있는) 서버의 토글 확인

```bash
curl -sk https://<host>:3443/api/analytics/config | python3 -m json.tool | grep -A1 ageEstimation
```

`ageEstimation: false`면 여기서 끝 — 토글을 켠다.

### Step 2 — 실제로 추론이 도는 서버가 어디인지 확인

```bash
curl -sk https://<host>:3443/health | python3 -m json.tool | grep serverMode
```

- `serverMode: "combined"` 또는 `"analysis"` → Step 3을 **이 서버**에서 실행
- `serverMode: "streaming"` → Step 3을 **원격 analysis 서버**(`ANALYSIS_SERVER_URL`, `server/.env`에서 확인)에서 실행해야 함. 이 로컬 서버의 `/api/analysis/metrics`는 원격 응답을 그대로 프록시(`analysisProxy.js`)하므로 curl 자체는 로컬에서 해도 되지만, 결과가 "원격 서버 상태"임을 유념

### Step 3 — 모델 로드 상태 확인 (2026-07-14 신규 진단 필드)

```bash
curl -sk https://<host>:3443/api/analysis/metrics | python3 -c "
import json,sys; d=json.load(sys.stdin); print(d.get('services',{}).get('ageEstimation'))"
```

| 값 | 의미 | 조치 |
|---|---|---|
| `not_started` | 카메라가 아직 한 번도 시작되지 않아 서비스가 lazy-load되지 않음 | 카메라 스트림을 시작한 뒤 재확인 |
| `missing` | 모델 파일이 `server/models/`에 없음 | Admin Dashboard에서 Download 실행 |
| `failed` | 모델 파일은 있으나 ONNX 세션 로드 실패 | 서버 콘솔의 `[AgeEstimationService] Model load failed: ...` 로그 확인 |
| `loaded` | 정상 — 이 단계는 원인이 아님, Step 4로 |
| (필드 자체가 없음) | `pipelineManager.js`가 커밋 `7f3c89e`(2026-07-14) 이전 버전 — `git pull` 후 서버 재시작 |

### Step 4 — DB 영속화 확인 (실시간엔 보이는데 이력엔 없는 경우)

```bash
curl -sk "https://<host>:3443/api/analysis/detection-tracks?limit=50" | python3 -c "
import json,sys
d=json.load(sys.stdin); tracks=d.get('tracks',[])
print('total:', len(tracks), '| with estimatedAge:', sum(1 for t in tracks if t.get('estimatedAge')))"
```

`total`은 0보다 큰데 `with estimatedAge`가 0이면:
- `streaming` 모드: Step 2-3을 원격 analysis 서버에서 다시 확인 — `services.ageEstimation !== 'loaded'`일 가능성이 가장 높음 (원격 서버가 최신 코드를 pull/재시작하지 않았거나 모델이 아직 로드되지 않음)
- `combined`/`analysis` 모드: `pipelineManager.js`가 오래된 버전일 가능성 — `git log -1 --format='%H %ci' -- server/src/services/pipelineManager.js`로 커밋 시점 확인 후 재배포

## 5. 실사례 (2026-07-14)

로컬 `streaming` 서버에서 `ageEstimation: true`(로컬 토글 정상), 원격 analysis 서버(`192.168.214.254:3443`)와의 연결도 정상(`circuitOpen: false`)이었으나, `detectionTracks` 200건 중 `estimatedAge` 보유 0건으로 관측됨. Step 2에서 `serverMode: streaming` 확인 → Step 3을 원격 서버에서 실행해야 함이 판명 → 원인은 원격 analysis 서버가 아직 최신 코드(퍼시스턴스/진단 필드 포함)를 pull·재시작하지 않았거나, 모델이 로드되지 않은 상태로 좁혀짐. 코드 추적으로 `remoteTracked`/`allDetections`의 스프레드 전달 경로 자체는 무결함을 확인해 "필드 유실 버그" 가능성은 배제.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — 활성화 절차, 라인 플로우 요약, 4단계 진단 절차(토글→서버모드→모델상태→DB영속화), 2026-07-14 실사례 기록 |
