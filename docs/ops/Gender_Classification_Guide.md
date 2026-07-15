# OPERATIONS GUIDE
# AI Gender Classification — Setup & Diagnostics

| | |
|---|---|
| Document ID | OPS-GEN-001 |
| Version | 1.3 |
| Status | Active |
| Date | 2026-07-14 |
| Related Design | design/Design_AI_Gender_Classification.md |
| Related SRS | srs/SRS_AI_Gender_Classification.md |
| Related TC | tc/TC_AI_Gender_Classification.md |

---

## 1. 개요

Gender Classification은 opt-in AI 모듈로, 감지된 person의 성별을 예측한다(InsightFace GenderAge 또는 ViT Gender Classifier 중 택1). Age Estimation과 완전히 동일한 활성화 절차·라인 플로우·진단 절차를 따르되, **Age Estimation이 2026-07-12~07-14에 겪은 streaming 모드 갭(양쪽 진입점 중 하나만 구현)이 이 모듈에는 최초 구현부터 존재하지 않는다**는 점이 다르다. 이 문서는 그 사실을 실제로 검증하는 절차를 포함한다.

---

## 2. 활성화 절차

1. Admin Dashboard → AI Models → "Gender Classification" 섹션에서 두 모델 중 하나 Download → Activate
   - `insightface-genderage-gender`는 Age Estimation의 `insightface-genderage`와 **동일 파일**(`genderage.onnx`)이다 — Age Estimation을 이미 사용 중이면 재다운로드 불필요(idempotent)
2. `PUT /api/analytics/config` (또는 Admin UI 토글)로 `genderClassification: true` 설정
3. `combined`/`analysis` 모드는 즉시 로컬에서 추론 시작. `streaming` 모드는 원격 analysis 서버(`ANALYSIS_SERVER_URL`)에서 위 1-2단계가 수행되어야 함

## 3. 라인 플로우 요약

전체 프레임→화면 데이터 흐름(두 진입점 포함 Mermaid 다이어그램)은 `Design_AI_Gender_Classification.md` §12를 참고. 요약:

```
카메라 프레임 → [streaming이면 HTTP로 analysis 서버에 위임] → 게이트(토글+모델ready)
  → person별 crop 선택(face 우선, 없으면 body) → 모델 추론 → {value,confidence,source,modelId}
  → detectionTracks/detectionSnapshots 영속화 + Socket.IO 실시간 emit
  → 클라이언트 4곳 표시(CameraView 오버레이 / FullscreenCameraView 목록 / DetectionsTimelineInline 상세 / SearchFullscreen 검색결과)
```

**Age Estimation과의 결정적 차이**: 위 흐름 중 "게이트→추론" 단계가 `pipelineManager.js`(로컬 카메라 루프)와 `analysisApi.js`(`POST /frame` 핸들러, streaming 위임 처리) **양쪽에 최초 구현부터 존재**한다. Age Estimation은 후자가 2026-07-14까지 아예 없어서 streaming 배포에서 100% 작동 불가였다.

## 4. 배포 후 필수 확인 — 두 진입점 검증 (Age Estimation 사고 재발 방지)

```bash
# 두 grep 모두 매치되어야 함 — 하나라도 없으면 Age Estimation과 동일한 결함
grep -n "_genderClassification.classifyGender\|GenderClassificationService" server/src/services/pipelineManager.js
grep -n "_genderClassification.classifyGender\|GenderClassificationService" server/src/routes/analysisApi.js
```

`streaming` 모드 배포라면, 실제로 원격 analysis 서버가 이 코드를 포함하는지도 확인:

```bash
# 원격 analysis 서버(SSH 접근 가능한 경우)에서
grep -n "_genderClassification.classifyGender" server/src/routes/analysisApi.js
```

## 5. 진단 절차 — "토글은 켰는데 화면에 안 보임"

Age Estimation의 `Age_Estimation_Guide.md` §4와 동일한 4단계(토글→서버모드→모델상태→DB영속화)를 따르되, 필드명만 치환한다:

### Step 1 — 로컬 서버의 토글 확인

```bash
curl -sk https://<host>:3443/api/analytics/config | python3 -m json.tool | grep -A1 genderClassification
```

### Step 2 — 실제로 추론이 도는 서버가 어디인지 확인

```bash
curl -sk https://<host>:3443/health | python3 -m json.tool | grep serverMode
```

`serverMode: "streaming"`이면 Step 3을 **원격 analysis 서버**에서 실행.

### Step 3 — 모델 로드 상태 확인

```bash
curl -sk https://<host>:3443/api/analysis/metrics | python3 -c "
import json,sys; d=json.load(sys.stdin); print(d.get('services',{}).get('genderClassification'))"
```

| 값 | 의미 | 조치 |
|---|---|---|
| `not_started` | 카메라가 아직 시작되지 않아 서비스 lazy-load 안 됨 | 카메라 스트림 시작 후 재확인 |
| `missing` | 모델 파일이 `server/models/`에 없음 | Admin Dashboard에서 Download 실행 |
| `failed` | 모델 파일은 있으나 ONNX 세션 로드 실패 | `[GenderClassificationService] Model load failed: ...` 로그 확인 |
| `loaded` | 정상 — Step 4로 |
| (필드 자체가 없음) | `pipelineManager.js`/`analysisApi.js`가 이 기능 이전 커밋 — `git pull` 후 재시작 |

### Step 4 — DB 영속화 확인

```bash
curl -sk "https://<host>:3443/api/analysis/detection-tracks?limit=50" | python3 -c "
import json,sys
d=json.load(sys.stdin); tracks=d.get('tracks',[])
print('total:', len(tracks), '| with estimatedGender:', sum(1 for t in tracks if t.get('estimatedGender')))"
```

`total`은 0보다 큰데 `with estimatedGender`가 0이면, §4의 두 grep 검증부터 먼저 재확인한다 — Age Estimation의 사례는 이 단계가 근본 원인이었다.

**2026-07-14 추가 확인:** §4의 grep이 통과(즉 `classifyGender()` 호출 코드는 존재)했는데도 여전히 0건이면, `analysisApi.js`가 `pipelineManager.js`와 별개로 보유한 `detectionTracks` 영속화 코드(3곳)에 `estimatedGender`가 빠져 있을 가능성을 확인한다 — Age Estimation의 근본 원인 2(`Age_Estimation_Guide.md` §4.5/§6)와 동일한 패턴이며, Gender Classification도 실제로 이 결함을 갖고 있었다가 같은 커밋에서 함께 수정됨:

```bash
grep -n "estimatedGender" server/src/routes/analysisApi.js
# 최소 6개 매치(3곳 × estimatedAge/estimatedGender 쌍 중 estimatedGender만 세면 3개) 이상이어야 정상
```

## 6. 정확도 문제 — 진단 및 개선 예정 (Planned, 2026-07-14, Design doc §13)

값이 화면·이력에 정상 도달해도(§4~§5 모두 정상), **실제 성비가 50:50에 가까운데도 대부분 여성으로 분류**되는 문제가 2026-07-14 보고됨(Age Estimation의 나이 편중과 같은 날 동일 사용자 보고, 원인도 대부분 공유 — `Age_Estimation_Guide.md` §7 참고).

### 즉시 확인 가능한 완화 조치

Age Estimation §7.1과 동일한 방법으로 body-crop 폴백 비율을 확인한다(`estimatedGender`가 실린 트랙 중 `source: 'body'` 비율). 얼굴 검출률이 낮으면 전신 crop이 얼굴 전용 모델에 입력되어 왜곡된 결과가 나올 가능성이 높다.

### 근본 원인 및 수정 현황 (2026-07-15 갱신)

HuggingFace `preprocessor_config.json` 실측(`rizvandwiki/gender-classification-2` 확인)과 `deepinsight/insightface` 소스 대조 결과: ViT 정규화 상수 오류, InsightFace 채널 순서 반전(가장 유력한 단일 원인 — 색공간이 일관되게 뒤바뀌면 무작위 노이즈가 아니라 한쪽으로 쏠리는 편향이 나타남), 표준편차 오류가 확인됨. 상세 근거는 `Design_AI_Gender_Classification.md` §13 및 `Design_AI_Age_Estimation.md` §13 참고(같은 `genderage.onnx` 파일을 공유하므로 원인·수정이 대부분 겹침).

| Phase | 내용 | 상태 |
|---|---|:---:|
| Phase 1 | 위 전처리 버그 코드 수정(`genderClassificationService.js`) | ✅ 완료 — `test/api/gender_classification.test.js` 11/11 통과(TC-GEN-017) |
| Phase 2~4 | 그래프 진단·랜드마크 정렬·신뢰도 임계값·검증 세트 | 🔲 미착수 |

**⚠️ 중요 — 이 서버(`SERVER_MODE=streaming`)에서 Phase 1 수정이 로컬 코드에는 반영되었으나, 실제 추론은 원격 analysis 서버(`192.168.214.254`)에서 수행되므로 그쪽에도 재배포해야 실제 효과가 나타난다.**

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — 활성화 절차, 라인 플로우 요약, 두 진입점 배포 후 검증 절차(§4, Age Estimation 사고 재발 방지), 4단계 진단 절차 |
| 1.1 | 2026-07-14 | §5 진단 절차에 "2026-07-14 추가 확인" 신규 — `analysisApi.js` 자체 `detectionTracks` 영속화 코드가 `estimatedGender`를 누락하고 있던 실제 결함(Age Estimation 근본 원인 2와 동일 패턴, FR-GEN-034/TC-GEN-016) 발견 및 수정 반영 |
| 1.2 | 2026-07-14 | **§6 신규 — 정확도 문제 진단 및 개선 예정** — 실제 성비 50:50에 가까운데도 대부분 여성으로 분류되는 실사용 관측 보고. Age Estimation과 원인을 공유함을 확인, 개선 계획은 Design doc §13 참고 — 코드 수정은 후속 |
| 1.3 | 2026-07-15 | §6 갱신 — Phase 1 코드 수정 완료(TC-GEN-017 통과) 및 원격 analysis 서버 재배포 필요성 명시. Phase 2~4는 여전히 미착수 |
