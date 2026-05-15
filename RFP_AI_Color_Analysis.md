# REQUEST FOR PROPOSAL (RFP)
# AI Module — Color Analysis (Appearance Attribute)

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-05 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `color` |
| **Status** | **Phase-1 구현 완료 (RGB 색상 추출) / Phase-2 PAR 준비중** |
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
| 0 | black | 검정 | #1a1a1a |
| 1 | white | 흰색 | #f5f5f5 |
| 2 | gray | 회색 | #808080 |
| 3 | red | 빨강 | #e53935 |
| 4 | orange | 주황 | #fb8c00 |
| 5 | yellow | 노랑 | #fdd835 |
| 6 | green | 초록 | #43a047 |
| 7 | blue | 파랑 | #1e88e5 |
| 8 | purple | 보라 | #8e24aa |
| 9 | pink | 분홍 | #f06292 |
| 10 | brown | 갈색 | #6d4c41 |

### 4.2 Extended Color Set (Optional)

| ID | Color | Korean | Notes |
|---|---|---|---|
| 11 | navy | 남색 | Dark blue |
| 12 | beige | 베이지 | Light tan |
| 13 | khaki | 카키 | Military green-tan |
| 14 | cyan | 청록 | Blue-green |
| 15 | silver | 은색 | Metallic gray |
| 16 | gold | 금색 | Metallic yellow |
| 17 | multicolor | 다색 | Complex patterns |

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
    "description": "빨간 상의, 파란 하의"
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

#### Phase-1: RGB 색상 추출 (즉시 사용 가능, 모델 불필요)

```
구현: colorClothService.js — avgColor() + rgbToColorName()
방법: sharp로 상체/하체 ROI를 8×8로 축소 → RGB 평균 → 11색 분류
정확도: 단순 heuristic (90%+ 일반 의류)
지연:   < 2ms per person
```

11색 분류표: `black, white, gray, red, orange, yellow, green, cyan, blue, purple, brown`

#### Phase-2: PAR 모델 (ML 기반 다중 속성)

| Source | URL | Notes |
|---|---|---|
| Event-AHU/OpenPAR (GH) | https://github.com/Event-AHU/OpenPAR | **Selected** — 40+ 속성 (색상+의류+모자+가방) |
| valencebond/Rethinking_of_PAR (GH) | https://github.com/valencebond/Rethinking_of_PAR | PA100K baseline |
| UPAR Dataset (GH) | https://github.com/speckean/upar_dataset | PA100K+PETA+RAP2 통합 40속성 |

#### Implementation Notes

```
서비스 파일: server/src/services/colorClothService.js
Phase-1:    즉시 동작 (모델 불필요)
Phase-2:    server/models/openpar.onnx 필요 (PyTorch → ONNX 변환 필요)

PyTorch → ONNX 변환:
  git clone https://github.com/Event-AHU/OpenPAR
  # 학습 후:
  torch.onnx.export(model, dummy_input_256x128, "openpar.onnx",
      input_names=["input"], output_names=["output"], opset_version=11)

Zone targetClasses에 'color' 또는 'cloth' 포함 시 자동 활성화
출력: detection.color.upper / detection.color.lower (색상명)
```

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
