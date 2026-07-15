# OPERATIONS GUIDE
# AI Age Estimation — Setup & Cross-Server Diagnostics

| | |
|---|---|
| Document ID | OPS-AGE-001 |
| Version | 1.4 |
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
| `loaded` | 모델은 정상 — 하지만 **`streaming` 모드라면 Step 3.5도 반드시 확인** (2026-07-14 근본 원인) |
| (필드 자체가 없음) | `pipelineManager.js`가 커밋 `7f3c89e`(2026-07-14) 이전 버전 — `git pull` 후 서버 재시작 |

### Step 3.5 — (streaming 모드 전용, 2026-07-14 근본 원인) `/frame` 핸들러에 실제로 추론 코드가 있는지 확인

`services.ageEstimation === 'loaded'`인데도 여전히 0건이면, 원격 analysis 서버가 **2026-07-14 이전 코드**를 실행 중일 가능성이 매우 높다 — `analysisApi.js`의 `POST /frame` 핸들러는 그 날짜 이전에는 Age Estimation을 아예 호출하지 않았다(`_ageEstimation`은 모델 카탈로그 switch/download 전용으로만 쓰였음). 토글·모델 로드·연결 상태가 전부 정상이어도 이 코드가 없으면 100% 안 나온다.

```bash
# 원격 analysis 서버(SSH 접근 가능한 경우)에서 직접 확인
grep -n "_ageEstimation.estimateAge" server/src/routes/analysisApi.js
# 매치가 없으면 → git pull && (재시작) 필요
```

SSH 접근이 없다면: `git log -1 --format='%H %ci'`로 원격 서버가 배포한 커밋 해시를 별도 경로(배포 스크립트 로그, 버전 API 등)로 확인하고, 이 문서의 §Revision History 1.1 이후 커밋이 포함됐는지 대조한다.

### Step 4 — DB 영속화 확인 (실시간엔 보이는데 이력엔 없는 경우)

```bash
curl -sk "https://<host>:3443/api/analysis/detection-tracks?limit=50" | python3 -c "
import json,sys
d=json.load(sys.stdin); tracks=d.get('tracks',[])
print('total:', len(tracks), '| with estimatedAge:', sum(1 for t in tracks if t.get('estimatedAge')))"
```

`total`은 0보다 큰데 `with estimatedAge`가 0이면:
- `streaming` 모드: Step 3.5(코드 버전)를 가장 먼저 의심 — `services.ageEstimation === 'loaded'`이어도 2026-07-14 이전 코드면 100% 0건이 나옴. **단, Step 3.5를 통과(즉 `_ageEstimation.estimateAge` 호출 코드가 존재)해도 여전히 0건이면 Step 4.5로 진행**
- `combined`/`analysis` 모드: `pipelineManager.js`가 오래된 버전일 가능성 — `git log -1 --format='%H %ci' -- server/src/services/pipelineManager.js`로 커밋 시점 확인 후 재배포

### Step 4.5 — (2026-07-14 근본 원인 2, Fullscreen Detections 타임라인 재보고) `analysisApi.js` 자체 영속화 코드의 필드 누락 확인

Step 3.5(추론 호출 코드 존재)와 Step 3(모델 `loaded`)를 모두 통과했는데도 `GET /api/analysis/detection-tracks`에 `estimatedAge`가 0건이면, `analysisApi.js`가 `pipelineManager.js`와 **별개로 자체 보유한** `detectionTracks` 저장 코드(3곳: `ctx._trackMeta` 갱신, 30초 주기 active-flush, 트랙 종료 flush)에 `estimatedAge`/`estimatedGender` 필드 자체가 빠져 있을 가능성이 매우 높다 — 실제로 2026-07-14 발생한 사례(§5 참고).

```bash
# 원격 analysis 서버(SSH 접근 가능한 경우)에서 직접 확인 — 3곳 모두에 존재해야 함
grep -n "estimatedAge" server/src/routes/analysisApi.js
# 최소 6개 매치(각 필드가 3곳 × 2필드) 이상 나와야 정상. 매치가 부족하면 git pull 후 재시작 필요.
```

이 단계는 Step 3.5와 증상이 비슷하지만(둘 다 "streaming 모드에서 0건") **서로 다른 코드 결함**이다 — Step 3.5는 "추론 자체를 안 함", Step 4.5는 "추론은 하는데 저장을 안 함"이다. 자동 회귀 테스트: `node test/api/age_estimation.test.js`의 Group F(TC-AGE-016)가 이 3곳을 소스 검사로 확인한다.

## 5. 실사례 (2026-07-14)

로컬 `streaming` 서버에서 `ageEstimation: true`(로컬 토글 정상), 원격 analysis 서버(`192.168.214.254:3443`)와의 연결도 정상(`circuitOpen: false`)이었으나, `detectionTracks` 200건 중 `estimatedAge` 보유 0건으로 관측됨.

**1차 진단(불완전했음):** Step 2에서 `serverMode: streaming` 확인 → 원격 서버의 코드 미배포/모델 미로드로 추정.

**실제 근본 원인(재조사 후 확정):** `pipelineManager.js`의 `_processRemoteResult()`에 임시 진단 로그를 추가해 실제 운영 트래픽으로 확인한 결과, 원격에서 돌아온 `tracked` person 객체의 키가 `objectId,bbox,confidence,state,className,firstSeenAt`뿐 — `color`/`cloth`/`face`/`estimatedAge` 전부 없었다(하지만 `color`/`cloth` 분석은 활성화되어 있었고 DB엔 정상 저장되고 있었다는 점이 단서). 코드를 직접 읽어보니 `analysisApi.js`의 `POST /frame` 핸들러는 `_attrPipeline.enrich()`로 face/color/cloth는 처리하면서도 **Age Estimation 호출 자체가 코드에 없었다** — `_ageEstimation`은 모델 카탈로그 switch/download 엔드포인트에서만 쓰이고 있었다. 즉 Step 3.5가 실제 원인이었고, "재배포/재시작하면 해결될 것"이라는 1차 진단은 틀렸다 — 코드 자체를 고쳐야 했다(`analysisApi.js`에 Age Estimation 추론 블록 신규 추가, `FR-AGE-033`). `remoteTracked`/`allDetections`의 스프레드 전달 경로 자체는 무결함이었으나,애초에 부착되는 필드가 없었으니 "통과 경로가 멀쩡하다"는 사실 자체가 무의미했다.

## 6. 실사례 2 — Fullscreen Detections 타임라인 나이 미표시 재보고 (2026-07-14)

§5 수정(FR-AGE-033) 배포 후에도 사용자가 "Fullscreen Camera View의 Detections 타임라인에서 person을 선택하면 정보는 보이는데 나이가 없다"고 재보고. 라이브 화면(`CameraView.tsx`/`FullscreenCameraView.tsx`의 `DetectionRow`)에는 나이가 정상 표시되고 있어 §4의 Step 1~3.5는 전부 정상(토글 ON, 모델 `loaded`, `/frame` 핸들러가 `estimateAge()`를 실제로 호출)임을 먼저 확인 — 즉 estimation 자체는 문제가 없었다.

Step 4(DB 영속화 확인)로 좁혀 들어가자 `GET /api/analysis/detection-tracks`의 `estimatedAge` 보유 건수가 여전히 0이었다. 코드를 다시 읽어보니 §4.5에서 설명한 대로, `analysisApi.js`가 `pipelineManager.js`와 **완전히 별개로** 유지하는 자체 `detectionTracks` 저장 코드(3곳)에는 `estimatedAge`/`estimatedGender`가 애초에 필드 목록에 없었다 — `color`/`cloth`만 있었다. FR-AGE-033은 "추론을 호출하는가"만 고쳤을 뿐 "저장 코드가 그 결과를 담는가"는 별개 문제였고, 이번 결함이 바로 그것이었다.

**교훈:** `pipelineManager.js`와 `analysisApi.js`는 겉보기엔 같은 일(프레임 처리 → detectionTracks 저장)을 하는 것처럼 보이지만 실제로는 **완전히 독립된 코드 사본**이다. 한쪽에 새 속성(`estimatedAge`, `estimatedGender` 등)을 추가하는 수정을 했다면, 반드시 반대쪽도 같은 속성이 있는지 `grep`으로 대조 확인해야 한다 — 이 프로젝트에서 Age Estimation 기능 하나에서만 이미 두 번(FR-AGE-033, FR-AGE-034) 반복된 패턴이다. 수정: `analysisApi.js`의 3개 지점 모두에 `estimatedAge`/`estimatedGender` 추가(FR-AGE-034, TC-AGE-016).

## 7. 정확도 문제 — 진단 및 개선 예정 (Planned, 2026-07-14, Design doc §13)

값이 화면과 이력에 정상적으로 도달하더라도(§4~§6의 모든 갭이 해결된 상태), **값 자체가 부정확**할 수 있다 — 2026-07-14 실사용 관측: InsightFace 나이가 거의 항상 ~35, ViT 나이가 거의 항상 `20-29` 버킷으로 나온다는 보고.

### 7.1 즉시 확인 가능한 완화 조치 (코드 수정 전, 지금 바로 확인 가능)

```bash
curl -sk "https://<host>:3443/api/analysis/detection-tracks?limit=200&class=person" | python3 -c "
import json,sys
d=json.load(sys.stdin); tracks=d.get('tracks',[])
withAge=[t for t in tracks if t.get('estimatedAge')]
bodySourced=[t for t in withAge if t['estimatedAge'].get('source')=='body']
print('tracks with estimatedAge:', len(withAge), '| body-sourced (face 미검출로 폴백):', len(bodySourced))
"
```

`body-sourced` 비율이 높다면(예: 절반 이상), Design doc §13.2 항목 E(얼굴 전용 모델에 전신 crop 입력)가 정확도 저하의 큰 요인일 가능성이 높다 — 카메라 각도·해상도를 조정해 얼굴 검출률을 높이는 것만으로도 (근본 수정 전) 체감 정확도가 개선될 수 있다.

### 7.2 근본 원인 및 수정 현황 (2026-07-15 갱신)

HuggingFace `preprocessor_config.json` 실측과 `deepinsight/insightface` 공식 소스 대조로 3개 전처리 버그가 확인됨(ViT 정규화 상수 오류, InsightFace 채널 순서 반전, InsightFace 표준편차 오류) — 상세 근거는 `Design_AI_Age_Estimation.md` §13 참고.

| Phase | 내용 | 상태 |
|---|---|:---:|
| Phase 1 | 위 3개 전처리 버그 코드 수정(`ageEstimationService.js`) | ✅ 완료 — `test/api/age_estimation.test.js` 11/11 통과(TC-AGE-017) |
| Phase 2 | `genderage.onnx` 그래프 내장 정규화 여부 실측 진단 | 🔲 미착수 |
| Phase 3 | 5점 랜드마크 얼굴 정렬, body-crop 신뢰도 표시 | 🔲 미착수 |
| Phase 4 | 참조 이미지 정확도 검증 세트 | 🔲 미착수 |

**⚠️ 중요 — 이 서버(`SERVER_MODE=streaming`)에서 Phase 1 수정이 로컬 코드에는 반영되었으나, 실제 추론은 원격 analysis 서버(`192.168.214.254`)에서 수행되므로 그쪽에도 재배포해야 실제 효과가 나타난다** — §3.5/§4.5와 동일한 배포 확인 절차(원격 서버의 `git log`/커밋 해시 확인)를 이번 수정에도 적용할 것.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — 활성화 절차, 라인 플로우 요약, 4단계 진단 절차(토글→서버모드→모델상태→DB영속화), 2026-07-14 실사례 기록 |
| 1.1 | 2026-07-14 | **실제 근본 원인 확정** — Step 3.5 신규(streaming 모드의 `/frame` 핸들러 코드 버전 확인), §5 실사례를 1차(불완전한) 진단과 실제 근본 원인으로 구분해 재작성. `analysisApi.js`에 Age Estimation 추론 블록이 아예 없었던 구조적 결함(FR-AGE-033) 반영 |
| 1.2 | 2026-07-14 | **근본 원인 2 신규** — Step 4.5 추가(`analysisApi.js` 자체 `detectionTracks` 영속화 코드의 필드 누락 확인), §6 실사례 2 신규(Fullscreen Detections 타임라인 나이 미표시 재보고 → FR-AGE-034/TC-AGE-016으로 수정) |
| 1.3 | 2026-07-14 | **§7 신규 — 정확도 문제 진단 및 개선 예정** — 나이가 대부분 ~35/`20-29`로 수렴하는 실사용 관측 보고. 즉시 확인 가능한 완화 조치(body-crop 폴백 비율 확인)와 근본 원인 요약(Design doc §13 참고) 추가 — 코드 수정은 후속 |
| 1.4 | 2026-07-15 | §7.2 갱신 — Phase 1 코드 수정 완료(TC-AGE-017 통과) 및 원격 analysis 서버 재배포 필요성 명시. Phase 2~4는 여전히 미착수 |
