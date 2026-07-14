# DESIGN DOCUMENT
# AI Module — Age Estimation

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-AGE-01 |
| **Version** | 1.4 |
| **Status** | Proposed (opt-in) |
| **Date** | 2026-07-14 |
| **Parent SRS** | [SRS_AI_Age_Estimation](../srs/SRS_AI_Age_Estimation.md) |
| **Related** | [Design_AI_Model_Catalog](Design_AI_Model_Catalog.md), [Design_AI_Cloth_Analysis](Design_AI_Cloth_Analysis.md) |

---

## 목차

1. [개요](#1-개요)
2. [아키텍처 개요](#2-아키텍처-개요)
3. [파일 구조](#3-파일-구조)
4. [모델 카탈로그 통합](#4-모델-카탈로그-통합)
5. [PT→ONNX 변환 — `hfOptimumExport`](#5-ptonnx-변환--hfoptimumexport)
6. [AgeEstimationService 설계](#6-ageestimationservice-설계)
7. [입력 소스 폴백 로직](#7-입력-소스-폴백-로직)
8. [Admin Dashboard 통합](#8-admin-dashboard-통합)
9. [데이터 모델](#9-데이터-모델)
10. [오류 처리 및 한계](#10-오류-처리-및-한계)
11. [검증 (Verification)](#11-검증-verification)

---

## 1. 개요

Age Estimation은 추적된 person에 대해 정밀 연령 예측을 수행하는 opt-in AI 모듈이다. 기존 cloth-PAR(`colorClothService.js`)이 부산물로 내놓는 3단계 `ageGroup`과 독립적으로 동작하며, Admin Dashboard에서 두 모델(InsightFace GenderAge / ViT Age Classifier) 중 하나를 선택해 활성화한다 — cloth-PAR의 PromptPAR/OpenPAR 선택 패턴을 그대로 재사용한다.

## 2. 아키텍처 개요

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       SERVER (analysis / combined mode)                   │
│                                                                            │
│  routes/analysisApi.js                                                    │
│   ├─ EXTENDED_CATALOG += age-estimation (2 entries)                       │
│   ├─ _activeFileForEntry()  — case 'age-estimation'                      │
│   ├─ /models/switch          — case 'age-estimation'                      │
│   └─ /models/download        — entry.hfOptimumExport branch (신규)       │
│                                                                            │
│  services/ageEstimationService.js (신규)                                  │
│   ├─ load()/reload()/ready/status                                        │
│   └─ estimateAge(jpegBuffer, bbox, {isFaceCrop}) → {value,bucket?,source} │
│                                                                            │
│  services/pipelineManager.js                                              │
│   ├─ this._ageEstimation = new AgeEstimationService()                    │
│   ├─ lazy-load in _doStartCamera()                                        │
│   └─ 감지 루프: face bbox 있으면 우선, 없으면 person bbox 폴백           │
│                                                                            │
│  services/tracking.js                                                     │
│   └─ sticky-attribute 목록에 'estimatedAge' 추가                         │
│                                                                            │
│  services/analyticsConfig.js                                              │
│   └─ DEFAULT_CONFIG.ageEstimation = false (opt-in)                        │
└──────────────────────────────┬─────────────────────────────────────────────┘
                                │ REST (/api/analysis/models*)
┌──────────────────────────────▼─────────────────────────────────────────────┐
│                   CLIENT — AdminUsersPage.tsx AiModelsSection()            │
│   제네릭 카탈로그 테이블이 age-estimation family를 자동 렌더링             │
│   (신규 컴포넌트 불필요 — 상수 4곳만 갱신)                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 3. 파일 구조

```
loitering_tracking/
├── server/
│   ├── models/
│   │   ├── genderage.onnx              # InsightFace GenderAge (다운로드 시 생성)
│   │   └── vit_age_classifier.onnx     # ViT Age Classifier (hfOptimumExport 변환 시 생성)
│   └── src/
│       ├── routes/
│       │   └── analysisApi.js          # 카탈로그·switch·download 핸들러
│       └── services/
│           ├── ageEstimationService.js # 신규
│           ├── pipelineManager.js      # 감지 루프 연동
│           ├── tracking.js             # sticky-attribute 목록
│           └── analyticsConfig.js      # ageEstimation 토글
└── docs/
    ├── rfp/RFP_AI_Age_Estimation.md
    ├── prd/PRD_AI_Age_Estimation.md
    ├── srs/SRS_AI_Age_Estimation.md
    ├── design/Design_AI_Age_Estimation.md   # 이 문서
    └── tc/TC_AI_Age_Estimation.md
```

## 4. 모델 카탈로그 통합

**파일:** `server/src/routes/analysisApi.js` — `EXTENDED_CATALOG` 배열

```javascript
// Age Estimation (Proposed) — dedicated age prediction, independent of the
// PA100k cloth-PAR ageGroup byproduct (see RFP_AI_Age_Estimation.md §9).
{
  id: 'insightface-genderage', label: 'InsightFace GenderAge (buffalo_l)',
  family: 'age-estimation', series: 'Age Estimation',
  file: 'genderage.onnx', size: 96,
  url: 'https://huggingface.co/JackCui/facefusion/resolve/main/gender_age.onnx', // 구현 시 재검증 필요, §11
  license: 'InsightFace non-commercial research license (acceptable — non-commercial project)',
},
{
  id: 'vit-age-classifier', label: 'ViT Age Classifier (nateraw)',
  family: 'age-estimation', series: 'Age Estimation',
  file: 'vit_age_classifier.onnx', size: 224,
  hfOptimumExport: { repo: 'nateraw/vit-age-classifier' },
  license: 'See Hugging Face model card',
  classMap: VIT_AGE_BUCKET_CLASSES,
},
```

`_activeFileForEntry()`에 추가되는 분기 (기존 `appearance-reid` 케이스와 동일 구조):

```javascript
case 'age-estimation':
  return _ageEstimation?.ready ? path.basename(_ageEstimation.modelPath) : null;
```

## 5. PT→ONNX 변환 — `hfOptimumExport`

기존 `hfExport`(PPE/Fire-Smoke)는 `ultralytics.YOLO(pt).export(format="onnx")`만 지원하며, ViT 분류기 같은 non-YOLO HuggingFace Transformers 아키텍처는 변환할 수 없다. 이를 위해 **HuggingFace `optimum`** 라이브러리를 사용하는 새 소스 전략을 추가한다.

```
소스 전략 비교:
  url               → 순수 HTTP(S) ONNX 다운로드 (변환 없음)
  requiresConversion→ GitHub .pt 릴리스 → ultralytics export (YOLO26/12)
  hfExport          → HuggingFace .pt 다운로드 → ultralytics export (PPE, Fire-Smoke)
  hfOptimumExport   → HuggingFace 체크포인트 → optimum.exporters.onnx.main_export (신규 — ViT 등 non-YOLO)
  manualOnly        → 자동화 불가 — 수동 export 필요 (OpenPAR)
```

`/models/download` 핸들러 신규 분기:

```javascript
} else if (entry.hfOptimumExport) {
  const pyExec = await _findPythonWithOptimum();
  if (!pyExec) throw new Error('Python with optimum + transformers not found. Run: pip install -U optimum-onnx transformers');

  _downloadProgress.set(modelId, { status: 'converting', percent: 50, error: null });
  const tmpDir = path.join(modelsDir, `.${modelId}-export-tmp`);
  const script = [
    'from optimum.exporters.onnx import main_export',
    `main_export(model_name_or_path=${JSON.stringify(entry.hfOptimumExport.repo)}, output=${JSON.stringify(tmpDir)}, task="image-classification")`,
  ].join('; ');
  await new Promise((resolve, reject) => {
    execFile(pyExec, ['-c', script], { timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) { console.error('[AnalysisAPI] optimum export stderr:', stderr); return reject(err); }
      resolve();
    });
  });
  fs.copyFileSync(path.join(tmpDir, 'model.onnx'), filePath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
```

`_findPythonWithOptimum()` — `_findPythonWithUltralytics()` 바로 아래 추가, 동일한 후보 목록을 순회하되 `import optimum, transformers`를 체크한다.

## 6. AgeEstimationService 설계

**파일:** `server/src/services/ageEstimationService.js` (신규, `appearanceReidService.js` 템플릿)

```javascript
class AgeEstimationService {
  constructor({ modelPath } = {}) { /* status: not_started|missing|loaded|failed */ }
  async load() { /* fs.existsSync 체크 → createOnnxSession */ }
  async reload(filePath) { /* 모델 카탈로그 hot-swap */ }
  get ready() {}
  get status() {}
  async estimateAge(jpegBuffer, bbox, { isFaceCrop }) {
    // 활성 모델(this.modelPath 기준)에 따라 전처리/후처리 분기
    // InsightFace: 96×96 BGR → 회귀 age
    // ViT:        224×224 RGB, ImageNet 정규화 → 9-bucket softmax argmax → 중앙값
    // 반환: { value, bucket?, source: isFaceCrop ? 'face' : 'body', modelId }
  }
}
```

### 6.1 모델별 전처리 계약 (구현 시 실제 ONNX 메타데이터로 재검증 — §11)

| | InsightFace GenderAge | ViT Age Classifier |
|---|---|---|
| 입력 크기 | 96×96 | 224×224 |
| 채널 순서 | BGR (추정 — InsightFace 관례) | RGB |
| 정규화 | `(pixel - 127.5) / 127.5` (추정) | ImageNet mean/std |
| 출력 | `[1,3]` — gender 2채널 + age 1채널 (스케일 미확인) | `[1,9]` softmax logits |
| 후처리 | `age = round(output[2] * 100)` (추정) | `bucket = VIT_AGE_BUCKET_CLASSES[argmax(logits)]`, `value = midpoint(bucket)` |

`VIT_AGE_BUCKET_CLASSES`는 `colorClothService.js`의 `SCHP_LIP20_CLASS_MAP` export 패턴과 동일하게 `ageEstimationService.js`에서 export되어 `analysisApi.js`가 카탈로그 `classMap`으로 연결한다:

```javascript
const VIT_AGE_BUCKET_CLASSES = ['0-2','3-9','10-19','20-29','30-39','40-49','50-59','60-69','more than 70'];
```

## 7. 입력 소스 폴백 로직

**파일:** `server/src/services/pipelineManager.js` 감지 루프

```
For each person object in attrObjects (매 프레임, enrich() 이후):
  if analyticsConfig.ageEstimation !== true → skip
  if obj.face?.bbox 존재 (face 모듈 활성 시 attributePipeline이 부여)
    → _getAgeEstimate(jpegBuffer, obj.objectId, obj.face.bbox, isFaceCrop: true)
  else if obj.bbox (YOLO person bbox) 존재
    → _getAgeEstimate(jpegBuffer, obj.objectId, obj.bbox, isFaceCrop: false)
  else
    → skip (에러 없이 건너뜀)

  _getAgeEstimate()는 objectId별 4초 캐시(this._ageEstimateCache) 적용 — 매 프레임 재추론하지 않음
  결과 → obj.estimatedAge = { value, bucket?, source, modelId }
       → behaviorEngine.update()의 {...obj} 스프레드로 enrichedObjects까지 그대로 전파 (스냅샷·Socket.IO 노출)
       → 동시에 tracker.updateEstimatedAge(obj.objectId, obj.estimatedAge)로 track.estimatedAge에도 기록 (§6.1의 코드 정정 참고)
```

`tracking.js`의 `Track` 클래스에 `estimatedAge` 필드와 `ByteTracker.updateEstimatedAge(objectId, estimatedAge)` 메서드를 추가 — 기존 `color`/`cloth`/`accessories`와 동일한 per-attribute 패턴(`updateColor`/`updateCloth`/`updateAccessories`)을 그대로 따른다.

> **구현 중 발견 — 문서 정정**: 최초 설계 시 "`gender`/`ageGroup`/`lower`/`sleeve`를 관리하는 공용 sticky-attribute 목록에 추가"라고 서술했으나, 실제 코드를 확인한 결과 그런 공용 목록은 존재하지 않는다. 해당 4개 필드는 `cloth` 객체 내부에 중첩된 필드이며, `Track._clothSim()`(재식별 유사도 스코어러)에서만 읽힌다 — Track 필드 자체가 프레임 간 값을 화면에 "지속"시키는 메커니즘이 아니라, ByteTrack 재연결(Re-ID) 시 매칭 비용 함수가 참고하는 내부 메모리일 뿐이다. `color`/`cloth`/`accessories`와 마찬가지로 `estimatedAge`도 현재는 어떤 유사도 스코어러에서도 사용되지 않는다 — 기존 per-attribute 패턴과의 일관성을 위해 필드만 추가했으며, 향후 재식별 스코어링에 활용할 여지를 남겨둔 것이다. 클라이언트/스냅샷에 실제로 노출되는 `estimatedAge` 값은 `pipelineManager.js`가 매 프레임 `attrObjects`에 직접 부착하는 값(4초 캐시, §7)이며, `behaviorEngine.update()`의 스프레드(`{...obj}`)를 통해 `enrichedObjects`로 그대로 전파된다.

## 8. Admin Dashboard 통합

`client/src/pages/admin/AdminUsersPage.tsx`에 다음 4곳만 갱신 (신규 컴포넌트 없음):

1. `ModelCatalogEntry.family` 유니온에 `'age-estimation'` 추가
2. `EXTENDED_SERIES_ORDER` / `PROPOSED_SERIES`에 `'Age Estimation'` 추가
3. `ADMIN_MODULE_GROUPS`의 `attributes` 그룹에 `ageEstimation` 항목 추가
4. 나머지는 `AiModelsSection()`의 제네릭 테이블이 자동 처리 — cloth-par와 동일하게 두 항목이 독립 Activate/Download 버튼과 함께 렌더링됨

## 9. 데이터 모델

```typescript
// client/src/types/index.ts 확장 (선택, 표시가 필요할 때)
export interface EstimatedAge {
  value:    number;
  bucket?:  string;              // ViT 모델일 때만
  source:   'face' | 'body';
  modelId:  string;
}
```

## 10. 오류 처리 및 한계

| 상황 | 처리 방법 |
|---|---|
| 모델 파일 없음 | `status: 'missing'`, `estimateAge()` 호출 시 `null` 반환 — 파이프라인 정상 계속 |
| face bbox·person bbox 모두 없음 | 해당 프레임에서 조용히 skip |
| `analyticsConfig.ageEstimation === false` (기본값) | 크롭 추출·추론 자체가 발생하지 않음 — 성능 영향 0 |
| InsightFace 정확한 출력 텐서 계약 미검증 | §11 참조 — 프로덕션 반영 전 실제 모델로 검증 필요 |
| 두 모델의 `value` 스케일 차이 (회귀 vs. bucket 중앙값) | UI/검색에는 항상 `source`와 `modelId`를 함께 노출해 혼동 방지 |
| `insightface-genderage` 다운로드 URL이 HTTP 401 반환 (2026-07-14 관측 — 2026-07-12엔 정상 다운로드됨) | 저장소가 gated로 바뀌었거나 익명 접근이 제한된 것으로 추정. `server/.env`에 `HF_TOKEN`(https://huggingface.co/settings/tokens) 설정 시 `*.huggingface.co` 호스트에 한해 `Authorization: Bearer` 헤더가 자동 첨부됨(analysisApi.js `doDownload()`) |
| `torch`/`optimum`/`gdown` 등 Python 패키지 미설치로 모델 변환 실패 | 2026-07-14부터 자동 해결 — 최초 감지 실패 시 `_pipInstall()`이 해당 인터프리터에 필요 패키지를 자동 설치 후 재시도(비동기 실행이라 서버 이벤트 루프를 막지 않음). 그래도 실패하면 기존과 동일한 안내 에러 메시지 반환 |

## 11. 검증 (Verification)

- ~~`insightface-genderage`의 정확한 HuggingFace 미러 URL~~ — **검증 완료(2026-07-12)**: `POST /api/analysis/models/download`로 실제 다운로드해 `server/models/genderage.onnx`(1,322,532 bytes)가 정상 생성됨을 확인했고, 이어서 `POST /api/analysis/models/switch`로 활성화(`active: true`)까지 성공했다. **(2026-07-14 추가)** 같은 URL이 이후 HTTP 401을 반환하기 시작함이 사용자 보고로 확인됨 — 위 §10 표 및 HF_TOKEN 지원 참고, 재검증 필요.
- ONNX 세션의 `session.inputNames`/`outputNames`/shape를 실제로 로드해 §6.1 표의 전처리 계약을 재확인 — **미검증으로 남음**: 모델 로드 자체는 성공했으나, 실제 얼굴 이미지로 추론해 나온 `value`가 실제 나이와 부합하는지(출력 채널 순서·스케일 팩터 가정이 맞는지)는 아직 검증되지 않았다. 프로덕션 반영 전 알려진 나이의 샘플 얼굴로 end-to-end 정확도 확인 필요.
- `optimum.exporters.onnx.main_export(..., task="image-classification")`가 `nateraw/vit-age-classifier` 체크포인트에 대해 실제로 `model.onnx`를 생성하는지 확인 (모델 카드의 `task` 이름이 다를 경우 조정) — 미검증 (Python `optimum`/`transformers` 환경이 없는 개발 환경에서 테스트됨)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-12 | 초기 작성 — Age Estimation 설계, `hfOptimumExport` PT→ONNX 변환 신규 도입 |
| 1.1 | 2026-07-12 | 구현 중 발견된 오류 정정 — §7/§9 "sticky-attribute 목록" 서술이 실제 코드와 불일치함을 확인(그런 공용 목록은 존재하지 않으며, `gender`/`ageGroup`/`lower`/`sleeve`는 `cloth` 객체 내부 필드로 `Track._clothSim()` 재식별 스코어러에서만 사용됨). `estimatedAge`는 `color`/`cloth`/`accessories`와 동일한 per-attribute 패턴(Track 필드 + `updateEstimatedAge()`)으로 정정 반영 |
| 1.2 | 2026-07-12 | §11 갱신 — 실 서버 기동 테스트로 `insightface-genderage`의 HuggingFace 미러 URL이 실제로 다운로드·활성화(`active:true`)됨을 확인(1,322,532 bytes). ONNX 출력 텐서의 정확한 나이 스케일·채널 계약은 여전히 미검증(알려진 나이 샘플 얼굴 end-to-end 검증 필요)으로 명시 |
| 1.3 | 2026-07-14 | §10/§11 갱신 — `insightface-genderage` 다운로드 URL이 HTTP 401로 전환됨을 반영, `HF_TOKEN` 환경변수 지원 추가(`analysisApi.js` `doDownload()`가 `*.huggingface.co` 호스트에 한해 `Authorization: Bearer` 헤더 첨부; `huggingface_hub` 기반 Python 경로는 기존부터 자동 지원). 또한 `_findPythonWithUltralytics`/`_findPythonWithOptimum`/`_findPythonForPromptPAR`가 필요 패키지 누락 시 자동 `pip install` 후 재시도하도록 변경(비동기 실행으로 이벤트 루프 비차단) |
| 1.4 | 2026-07-14 | §5 코드 스니펫 정정 — ONNX export 기능이 `optimum[exporters]`에서 별도 패키지 `optimum-onnx`로 이전됨을 반영(base `optimum` extra는 더 이상 `optimum.exporters.onnx`를 제공하지 않음, 실제 프로덕션에서 "pip install 성공 + optimum.exporters.onnx는 여전히 없음"으로 재현됨). `_findPythonWithOptimum()`의 자동 설치 패키지명·`await` 누락도 함께 정정 |
