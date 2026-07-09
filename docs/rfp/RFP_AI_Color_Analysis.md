# REQUEST FOR PROPOSAL (RFP)
# AI Module — Color Analysis (Appearance Attribute)

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-05 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `color` |
| **Status** | **Phase-1 Implemented (RGB color extraction) / Phase-1.5 K-Means Proposed / Phase-2 PAR Pending / Phase-3 Human Parsing Proposed** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Color Taxonomy](#4-color-taxonomy)
5. [Model Specification](#5-model-specification)
6. [Two-Stage Pipeline](#6-two-stage-pipeline)
7. [Integration Requirements](#7-integration-requirements)
8. [Performance Requirements](#8-performance-requirements)
9. [Evaluation Criteria](#9-evaluation-criteria)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Color Analysis AI Module**, which performs appearance color attribute analysis on detected persons. The module classifies the dominant colors of a person's upper body (top/shirt) and lower body (bottom/pants/skirt) from surveillance video frames, enabling color-based person search and re-identification within the LTS-2026 Loitering Detection & Tracking System.

### 1.2 Scope

- Body region segmentation: upper body and lower body ROI extraction
- Dominant color classification per body region (11 basic colors)
- Multi-label output (support for mixed patterns: striped, plaid)
- Integration as a zone-level attribute: `"targetClasses": ["color"]`
- Output used for: person search by color description, Re-ID assistance, alert enrichment

### 1.3 Zone Target Key

Zones with `"targetClasses": ["color"]` activate color attribute analysis for all persons in the zone. Color metadata is attached to each tracked object and included in alert notifications, enabling operators to search for "person wearing red top, blue jeans."

---

## 2. Use Cases

| Use Case | Description | Benefit |
|---|---|---|
| Person search by description | "Person in yellow jacket seen loitering at Gate A" | Verbal description → color query |
| Re-ID across cameras | Match person track across multiple camera views by color | Improved cross-camera tracking |
| Alert enrichment | Include color description in loitering alert notifications | Actionable for operators |
| Crowd color analytics | Aggregate clothing color distribution per zone over time | Behavioral pattern analysis |
| Witness-description matching | Match surveillance footage to verbal witness descriptions | Incident investigation |
| Color-based event trigger | Alert when person in specific color enters restricted zone | Access control by appearance |

---

## 3. Technical Requirements

### 3.1 Color Analysis Capability

| Requirement | Specification |
|---|---|
| Body regions | Upper body (top/shirt/jacket), Lower body (pants/skirt/dress) |
| Color classes | 11 basic colors (see Section 4) |
| Multi-color support | Top-2 dominant colors per region |
| Pattern detection | Solid, striped, plaid, patterned |
| Minimum body size | Upper region: 30×40 px; Lower region: 30×50 px |
| Simultaneous persons | Up to 30 per frame |

### 3.2 Input Specifications

| Stage | Input | Size |
|---|---|---|
| Person detection | Full JPEG frame | 1080p |
| Upper body ROI | Top 50% of person bbox | Variable |
| Lower body ROI | Bottom 55% of person bbox (with overlap) | Variable |
| Model input | Normalized RGB crops | 64×128 px (upper), 64×128 px (lower) |

### 3.3 Output Specifications

```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "color": {
    "upperBody": {
      "primary": "red",
      "secondary": "white",
      "pattern": "striped",
      "confidence": { "red": 0.82, "white": 0.61 }
    },
    "lowerBody": {
      "primary": "blue",
      "secondary": null,
      "pattern": "solid",
      "confidence": { "blue": 0.91 }
    },
    "description": "red/white striped top, blue pants"
  },
  "isLoitering": true,
  "dwellTime": 42.0
}
```

---

## 4. Color Taxonomy

### 4.1 Basic 11-Color Set (Berlin & Kay Universal Colors)

| ID | Color | Korean | Hex Reference |
|---|---|---|---|
| 0 | black | Black | #1a1a1a |
| 1 | white | White | #f5f5f5 |
| 2 | gray | Gray | #808080 |
| 3 | red | Red | #e53935 |
| 4 | orange | Orange | #fb8c00 |
| 5 | yellow | Yellow | #fdd835 |
| 6 | green | Green | #43a047 |
| 7 | blue | Blue | #1e88e5 |
| 8 | purple | Purple | #8e24aa |
| 9 | pink | Pink | #f06292 |
| 10 | brown | Brown | #6d4c41 |

### 4.2 Extended Color Set (Optional)

| ID | Color | Korean | Notes |
|---|---|---|---|
| 11 | navy | Navy | Dark blue |
| 12 | beige | Beige | Light tan |
| 13 | khaki | Khaki | Military green-tan |
| 14 | cyan | Cyan | Blue-green |
| 15 | silver | Silver | Metallic gray |
| 16 | gold | Gold | Metallic yellow |
| 17 | multicolor | Multicolor | Complex patterns |

### 4.3 Pattern Classes

| Pattern | Description |
|---|---|
| `solid` | Single dominant color |
| `striped` | Regular linear stripes |
| `plaid` | Checkered/tartan pattern |
| `dotted` | Polka dot pattern |
| `printed` | Logo, graphic, or complex print |
| `camouflage` | Camo pattern |
| `mixed` | Cannot classify clearly |

---

## 5. Model Specification

### 5.1 Color Classification Model Options

| Model | Architecture | Top-1 Accuracy | Size | Latency/crop |
|---|---|---|---|---|
| MobileNetV2 (11-class) | MobileNetV2 | 88.5% | ~14MB | ~3ms |
| EfficientNet-B0 (11-class) | EfficientNet-B0 | 91.2% | ~20MB | ~4ms |
| MobileNetV3-Small (11-class) | MobileNetV3-S | 87.3% | ~6MB | ~2ms |
| SqueezeNet-color | SqueezeNet 1.1 | 84.6% | ~5MB | ~1.5ms |
| ResNet-18 + attention (11-class) | ResNet-18 | 93.1% | ~45MB | ~5ms |

**Recommended**: EfficientNet-B0 for server; MobileNetV3-Small for edge

### 5.2 Model Architecture

```
Input: 64×128 RGB crop (upper or lower body)
    │
    ▼ Backbone: EfficientNet-B0 (ImageNet pre-trained)
    │
    ▼ Global Average Pooling
    │
    ▼ Dropout (0.3)
    │
    ├─ Color head: FC(11) + Softmax → primary color (11-class)
    └─ Pattern head: FC(7) + Softmax → pattern type (7-class)
```

### 5.3 Alternative: HSV Histogram Method

For low-latency edge scenarios where DNN inference is too slow, an HSV histogram method can provide approximate color:

```javascript
// Fast HSV-based dominant color estimation
function estimateDominantColor(roiPixels) {
  const hsv = convertToHSV(roiPixels);
  const histogram = computeHHist(hsv, bins=36);
  const dominantHue = argmax(histogram);
  return hueToColorName(dominantHue);
}
```

Accuracy: ~82%, Latency: < 0.5ms. Recommended as fallback.

### 5.4 Body ROI Extraction

```javascript
function extractBodyRegions(personBbox) {
  const { x, y, width, height } = personBbox;
  return {
    // Upper body: ~0% to 55% of height (shirt/jacket area)
    upper: {
      x:      x + width * 0.05,
      y:      y + height * 0.10,
      width:  width * 0.90,
      height: height * 0.45,
    },
    // Lower body: ~45% to 100% of height (pants/skirt area)
    lower: {
      x:      x + width * 0.10,
      y:      y + height * 0.50,
      width:  width * 0.80,
      height: height * 0.45,
    },
  };
}
```

---

## 6. Two-Stage Pipeline

### 6.1 Pipeline Architecture

```
RTSP Frame (JPEG Buffer)
    │
    ▼ Primary Detection (YOLOv8n) — person bboxes
    │
    ▼ For each tracked person (className === 'person'):
    │
    ├─ Extract upper body ROI (top 55% of bbox)
    │     └─ Resize → 64×128 px
    │     └─ EfficientNet-B0 color classifier
    │     └─ Output: { primary, secondary, pattern, confidence }
    │
    ├─ Extract lower body ROI (bottom 55% of bbox)
    │     └─ Resize → 64×128 px
    │     └─ EfficientNet-B0 color classifier
    │     └─ Output: { primary, secondary, pattern, confidence }
    │
    ▼ Temporal smoothing (EMA over 10 frames)
    │  → Stabilize color labels (prevent flickering)
    │
    ▼ Attach color metadata to tracked object
    │  { ..., color: { upperBody, lowerBody, description } }
    │
    ▼ Emit via Socket.IO + store in alert metadata
```

### 6.2 Temporal Color Smoothing

To prevent color label flickering across frames:

```javascript
// Exponential moving average over last 10 frames
function smoothColorHistory(history, newLabel, alpha = 0.3) {
  const counts = {};
  for (const frame of history.slice(-10)) {
    counts[frame] = (counts[frame] || 0) + 1;
  }
  counts[newLabel] = (counts[newLabel] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
```

---

## 7. Integration Requirements

### 7.1 Zone Configuration

```json
{
  "id": "zone-uuid",
  "name": "Main Entrance Monitor",
  "type": "MONITOR",
  "targetClasses": ["human", "color"],
  "colorFilter": {
    "enabled": false,
    "alertColors": ["red", "orange"]
  },
  "dwellThreshold": 30
}
```

### 7.2 Alert Schema Extension

```json
{
  "type": "loitering",
  "cameraId": "cam-01",
  "objectId": "uuid",
  "zoneName": "Main Entrance Monitor",
  "dwellTime": 45.2,
  "appearance": {
    "upperBody": { "primary": "red", "pattern": "solid" },
    "lowerBody": { "primary": "blue", "pattern": "solid" },
    "description": "red top, blue bottom"
  },
  "timestamp": 1715678901234
}
```

### 7.3 Person Search API

```
GET /api/events?upperColor=red&lowerColor=blue&fromTime=2026-05-01&toTime=2026-05-15
```

Response: list of events where person wore matching colors.

---

## 8. Performance Requirements

### 8.1 Accuracy

| Metric | Minimum | Target |
|---|---|---|
| Top-1 color accuracy (11-class) | ≥ 85% | ≥ 92% |
| Top-2 color accuracy | ≥ 92% | ≥ 97% |
| Pattern classification accuracy | ≥ 80% | ≥ 88% |
| Color description F1 (human eval) | ≥ 80% | ≥ 90% |

### 8.2 Robustness

| Condition | Requirement |
|---|---|
| Illumination | Works under 200–5,000 lux |
| Shadow | Maintain ≥ 80% accuracy under partial shadow |
| Camera angle | ≤ 45° elevation |
| Minimum ROI size | Upper: ≥ 30×40 px; Lower: ≥ 30×50 px |
| Occlusion | Analyze visible portion only |

### 8.3 Latency

| Stage | Maximum Latency |
|---|---|
| ROI extraction | < 1ms |
| Upper body classification | < 4ms |
| Lower body classification | < 4ms |
| **Total per person** | **< 10ms** |
| **Total per frame (10 persons, batched)** | **< 15ms** |

---

## 9. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Color classification accuracy | 40% | 11-class accuracy on RAP / PA-100K datasets |
| Robustness | 20% | Accuracy under illumination / shadow / angle variations |
| Person search quality | 20% | Precision/recall on color-based person retrieval |
| Latency | 15% | Batch inference efficiency |
| Integration | 5% | API and ONNX compatibility |

---

## 10. Appendix

### Appendix A: Benchmark Datasets

| Dataset | Attributes | Instances |
|---|---|---|
| RAP v2 | 72 attributes including upper/lower color | 84,928 persons |
| PA-100K | 26 attributes | 100,000 persons |
| PETA | 61 attributes | 19,000 persons |
| Market-1501 + color labels | Color re-annotation | 32,668 images |

### Appendix B: Model File Placement

```
server/models/
├── yolov8n.onnx                   # Primary detection (existing)
├── color_upper_efficientb0.onnx   # Upper body color classifier
└── color_lower_efficientb0.onnx   # Lower body color classifier
```

### Appendix C: HSV-to-Color Mapping Table

| Hue Range (°) | Saturation | Brightness | Color |
|---|---|---|---|
| 0–15, 345–360 | ≥ 0.4 | ≥ 0.3 | red |
| 16–45 | ≥ 0.4 | ≥ 0.3 | orange |
| 46–75 | ≥ 0.4 | ≥ 0.3 | yellow |
| 76–160 | ≥ 0.3 | ≥ 0.25 | green |
| 161–260 | ≥ 0.3 | ≥ 0.25 | blue |
| 261–290 | ≥ 0.3 | ≥ 0.25 | purple |
| 291–345 | ≥ 0.3 | ≥ 0.4 | pink |
| Any | ≥ 0.2 | < 0.25 | black |
| Any | < 0.15 | ≥ 0.75 | white |
| Any | < 0.25 | 0.25–0.75 | gray |
| 16–45 | ≥ 0.3 | 0.3–0.6 | brown |

### Appendix E: Open Source Model Research (2026-05)

#### Phase-1: RGB Color Extraction (immediately usable, no model required)

```
Implementation: colorClothService.js — avgColor() + rgbToColorName()
Method: shrink upper/lower body ROI to 8×8 with sharp → RGB average → 11-color classification
Accuracy: simple heuristic (90%+ for common clothing)
Latency: < 2ms per person
```

11-color classification table: `black, white, gray, red, orange, yellow, green, cyan, blue, purple, brown`

#### Phase-2: PAR Model (ML-based multi-attribute)

| Source | URL | Notes |
|---|---|---|
| Event-AHU/OpenPAR (GH) | https://github.com/Event-AHU/OpenPAR | **Selected** — 40+ attributes (color+clothing+hat+bag) |
| valencebond/Rethinking_of_PAR (GH) | https://github.com/valencebond/Rethinking_of_PAR | PA100K baseline |
| UPAR Dataset (GH) | https://github.com/speckean/upar_dataset | PA100K+PETA+RAP2 unified 40 attributes |

#### Implementation Notes

```
Service file: server/src/services/colorClothService.js
Phase-1:    works immediately (no model required)
Phase-2:    server/models/openpar.onnx required (PyTorch → ONNX conversion needed)

PyTorch → ONNX conversion:
  git clone https://github.com/Event-AHU/OpenPAR
  # After training:
  torch.onnx.export(model, dummy_input_256x128, "openpar.onnx",
      input_names=["input"], output_names=["output"], opset_version=11)

Auto-activated when 'color' or 'cloth' is included in Zone targetClasses
Output: detection.color.upper / detection.color.lower (color name)
```

#### Phase-3: Human Parsing 기반 정밀 색상 분류 (Proposed, 2026-07-09)

**격차 분석 배경**: 참고 가이드 CCTV/IPTV 상의하의 색상분류 가이드(내용 통합 완료, 원본은 2026-07-09 삭제됨)와 `ReID_및_색상분석_활용가이드.md`를 현재 구현(Phase-1)과 비교한 결과, 현재 방식(고정 비율 bbox crop → 8×8 리사이즈 → 단순 픽셀 평균 → HSV 매핑)은 가이드가 제시하는 4단계 티어 중 **가장 단순한 티어("많은 현장에서는 별도 AI 모델 없이 처리")보다도 더 축약된 방식**이다 — 해당 티어는 K-Means/Dominant Color 추출을 전제하지만 현재는 단순 평균만 사용한다. 가이드의 최상위 티어는 Human Parsing(SCHP/CE2P/SegFormer)을 이용한 픽셀 단위 의류 마스크 추출을 권장한다.

**후보 모델 비교**:

| 모델 | 라이선스 | 클래스 | ONNX | 비고 |
|---|---|---|---|---|
| SCHP (LIP-20, ResNet-101) | MIT | 20 (LIP 데이터셋) | 커뮤니티 변환 존재 (`pirocheto/schp-lip-20`) | 정확도 높으나 무거움(473×473 기준) |
| SegFormer (`segformer_b2_clothes`, MiT-B2) | NVIDIA SegFormer NC(비상업) 라이선스 상속 | 18 (의류 세분화) | 즉시 사용 가능 (`Xenova/segformer_b2_clothes`) | **본 프로젝트는 상업 배포가 아니므로 NC 라이선스 제약이 적용되지 않음** — 사용 가능 |

**상호 대체(interchangeable) 설계**: 두 모델은 서로 다른 클래스 인덱스 체계를 가지므로, 기존 YOLO 탐지 모델 카탈로그(`GET/POST /api/analysis/models`)와 동일한 다운로드+활성화(Activate) UX를 Admin Dashboard의 "AI Models" 탭에 확장 적용하고, 모델별 `classMap`(어떤 클래스 인덱스가 상의/하의에 해당하는지) 메타데이터를 카탈로그 엔트리에 포함시켜 모델 교체 시에도 상의/하의 판정이 깨지지 않도록 한다. 상세 설계는 `docs/design/Design_AI_Color_Analysis.md` §10 참조.

**실시간 다채널 부담 완화**: 매 프레임 실행이 아니라 **트랙(track) 단위로 N초마다 1회만 실행**하고 결과를 캐시해 재사용한다 (사용자 결정, 2026-07-09).

**검토 후 제외한 대안 — Person Attribute Recognition (whole-crop)**: 가이드 2번째 티어(RAP/PETA 데이터셋 기반 ALM/MGN/OSNet-PAR, crop 전체에서 `{upper_color, lower_color, gender, backpack}` 직접 분류)도 검토했으나, 이미 존재하는 `openpar.onnx`(Phase-2, whole-crop 속성 분류)가 동일한 패턴이면서 색상 헤드가 없다는 점, 그리고 whole-crop 방식은 Phase-1의 고정 사각형 crop이 겪는 배경/피부색 오염 문제를 그대로 안고 있다는 점에서 픽셀 마스크 기반 Human Parsing을 우선 채택했다. 상세 근거는 `docs/design/Design_AI_Color_Analysis.md` §10.2 참조.

**검토 후 제외한 후보 모델 — CE2P**: 가이드 1번째 티어에 SCHP·SegFormer와 함께 CE2P도 나열되어 있으나, CE2P는 유지보수되는 ONNX 변환본이 공개되어 있지 않다(Caffe/PyTorch 연구용 체크포인트뿐). SCHP(`pirocheto/schp-lip-20`)와 SegFormer(`Xenova/segformer_b2_clothes`)는 즉시 사용 가능한 커뮤니티 ONNX가 있어 우선 채택했다. CE2P는 카탈로그에 등록하지 않았으며, 유지보수되는 ONNX가 공개되고 SCHP/SegFormer로 부족함이 확인될 경우 재검토 대상이다.

**Phase-1.5 (Proposed, 2026-07-09) — 가이드 4번째 티어(모델 불필요) 반영**: 가이드 §4("상하의 색상만 필요할 경우")는 Human Parsing 없이도 고정 상/하의 bbox split + K-Means/Dominant Color 조합으로 "실무 정확도 약 85~90%"를 달성할 수 있다고 명시한다. 이는 현재 Phase-1(고정 crop + 단순 평균)보다 더 정확하지만 Phase-3(Human Parsing 모델)보다는 훨씬 저렴한 중간 티어로, 지금까지의 Phase-3 제안만으로는 다루지 않았던 격차다. `server/src/utils/kmeansColor.js`(Phase-3용으로 이미 구현·테스트됨)를 재사용해 Phase-1의 8×8 단순 평균을 K-Means 대표색 추출로 교체하는 안을 Phase-1.5로 제안한다 — 모델 다운로드나 새 설정 토글 없이 항상 켜져 있는 Phase-1 경로 자체의 품질을 올리는 변경이다. 상세 설계는 `docs/design/Design_AI_Color_Analysis.md` §11 참조.

---

### Appendix D: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) | Person detection (upstream dependency) |
| [RFP_AI_Cloth_Analysis.md](RFP_AI_Cloth_Analysis.md) | Clothing type analysis (complementary) |
| [RFP_LTS2026_Loitering_Tracking_System.md](RFP_LTS2026_Loitering_Tracking_System.md) | Parent system RFP |

---

> **END OF DOCUMENT — LTS-2026-AI-05**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for AI Color Analysis |
| 1.1 | 2026-07-09 | Youngho Kim | Appendix E에 Phase-3 Human Parsing(SCHP/SegFormer) 제안 추가 — 가이드 문서(`CCTV_IPTV_상의하의_색상분류_가이드.md`, `ReID_및_색상분석_활용가이드.md`) 격차 분석 반영 |
| 1.2 | 2026-07-09 | Youngho Kim | Person Attribute Recognition(whole-crop) 대안 검토·제외 근거 추가 — 원본 가이드 삭제 전 최종 반영 확인 |
| 1.3 | 2026-07-09 | Youngho Kim | CE2P 후보 검토·제외 근거, Phase-1.5(가이드 4번째 티어 — K-Means, 모델 불필요) 제안 추가 — 원본 가이드 최종 반영 확인 |
| 1.4 | 2026-07-09 | Youngho Kim | 원본 가이드 `docs/rfp/CCTV_IPTV_상의하의_색상분류_가이드.md` 삭제 완료 — 내용 전체가 Appendix E에 반영되었음을 확인하고 본 문서 내 인용을 아카이브 표기로 변경 |
