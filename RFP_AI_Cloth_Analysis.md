# REQUEST FOR PROPOSAL (RFP)
# AI Module — Clothing Analysis (Cloth Type & Style)

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-06 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `cloth` |
| **Status** | Planned (not yet implemented) |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Clothing Taxonomy](#4-clothing-taxonomy)
5. [Model Specification](#5-model-specification)
6. [Two-Stage Pipeline](#6-two-stage-pipeline)
7. [Integration Requirements](#7-integration-requirements)
8. [Performance Requirements](#8-performance-requirements)
9. [Evaluation Criteria](#9-evaluation-criteria)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Clothing Analysis AI Module**, which identifies and classifies clothing types and styles worn by detected persons in surveillance video. The module enriches tracked person metadata with clothing category information, enabling precise person description, cross-camera re-identification, and behavioral pattern analysis within the LTS-2026 Loitering Detection & Tracking System.

### 1.2 Scope

- Clothing type classification: upper body garment (8 categories), lower body garment (6 categories)
- Clothing style attributes: sleeve length, collar type, fit style
- Full-body outfit classification for dress/jumpsuit/uniform detection
- Integration as a zone-level attribute: `"targetClasses": ["cloth"]`
- Complementary to color analysis ([RFP_AI_Color_Analysis.md](RFP_AI_Color_Analysis.md))

### 1.3 Zone Target Key

Zones configured with `"targetClasses": ["cloth"]` activate clothing type analysis for all persons. Useful for dress code compliance monitoring, uniform verification, or generating rich person descriptions for incident reports.

---

## 2. Use Cases

| Use Case | Description | Zone Config |
|---|---|---|
| Dress code enforcement | Detect persons not in uniform in formal zones | `["human", "cloth"]` |
| Person search by clothing | "Person in yellow jacket, jeans" — post-event search | `["cloth", "color"]` |
| Uniform compliance | Alert when staff not in required uniform | `["cloth"]` |
| Incident description | Auto-generate "red hoodie, black jeans" for reports | `["human", "cloth", "color"]` |
| Re-ID enrichment | Clothing type as supplementary Re-ID feature | `["human", "cloth"]` |
| VIP / uniform detection | Recognize security uniforms, medical gowns | `["cloth"]` |

---

## 3. Technical Requirements

### 3.1 Clothing Classification Capability

| Requirement | Specification |
|---|---|
| Body regions | Upper garment, lower garment, full-body outfit |
| Upper categories | 8 types (see Section 4) |
| Lower categories | 6 types (see Section 4) |
| Multi-label support | One person may wear multiple visible layers |
| Minimum person size | 60×150 pixels in 1080p |
| Simultaneous persons | Up to 20 per frame |

### 3.2 Input Specifications

| Stage | Input | Resize Target |
|---|---|---|
| Person detection | Full JPEG frame | — |
| Upper body ROI | Top 55% of person bbox | 128×192 px |
| Lower body ROI | Bottom 55% of person bbox | 128×192 px |
| Full body ROI | Full person bbox | 128×256 px |
| Model input | Normalized RGB | 128×256 px |

### 3.3 Output Specifications

```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "cloth": {
    "upperGarment": {
      "type": "hoodie",
      "confidence": 0.87,
      "sleeveLength": "long",
      "collar": "hood"
    },
    "lowerGarment": {
      "type": "jeans",
      "confidence": 0.92,
      "fit": "slim"
    },
    "fullBody": null,
    "description": "후드티, 청바지"
  },
  "isLoitering": true,
  "dwellTime": 38.4
}
```

---

## 4. Clothing Taxonomy

### 4.1 Upper Body Garment Categories

| ID | Type | Korean | Examples |
|---|---|---|---|
| 0 | t-shirt | 티셔츠 | Short sleeve, round neck |
| 1 | shirt | 셔츠 | Button-down, dress shirt |
| 2 | hoodie | 후드티 | Pullover/zip hoodie |
| 3 | sweater | 스웨터 | Knit, pullover, crewneck |
| 4 | jacket | 재킷 | Blazer, denim, bomber |
| 5 | coat | 코트 | Long coat, overcoat, trench |
| 6 | vest | 조끼 | Waistcoat, sleeveless |
| 7 | uniform_top | 유니폼 상의 | Work/school uniform |

### 4.2 Lower Body Garment Categories

| ID | Type | Korean | Examples |
|---|---|---|---|
| 0 | jeans | 청바지 | Denim jeans |
| 1 | trousers | 바지 | Chinos, slacks, dress pants |
| 2 | shorts | 반바지 | Short pants |
| 3 | skirt | 치마 | Mini, midi, maxi skirt |
| 4 | leggings | 레깅스 | Athletic, tight leggings |
| 5 | uniform_bottom | 유니폼 하의 | Work/school uniform bottom |

### 4.3 Full-Body Outfit Categories

| ID | Type | Korean | Examples |
|---|---|---|---|
| 0 | dress | 원피스 | Casual, formal dress |
| 1 | jumpsuit | 점프수트 | Overalls, boilersuit |
| 2 | suit | 정장 | Business suit (jacket + pants) |
| 3 | uniform_full | 전체 유니폼 | Security, medical, police |
| 4 | sportswear | 운동복 | Tracksuit, athletic set |

### 4.4 Clothing Attribute Sub-classes

| Attribute | Values |
|---|---|
| Sleeve length | `sleeveless`, `short`, `long`, `unknown` |
| Collar type | `round`, `v-neck`, `collar`, `hood`, `turtleneck`, `unknown` |
| Fit | `loose`, `regular`, `slim`, `unknown` |
| Pattern | `solid`, `striped`, `plaid`, `printed`, `mixed` |
| Material visual | `denim`, `leather`, `wool_knit`, `athletic`, `formal`, `unknown` |

---

## 5. Model Specification

### 5.1 Clothing Classification Model Options

| Model | Architecture | Accuracy | Size | Latency/crop |
|---|---|---|---|---|
| EfficientNet-B0 (multi-label) | EfficientNet-B0 | 89.2% mAP | 20MB | ~5ms |
| ResNet-34 (multi-task) | ResNet-34 | 91.5% mAP | 83MB | ~8ms |
| MobileNetV2 (multi-label) | MobileNetV2 | 85.6% mAP | 14MB | ~3ms |
| ViT-Small (transformer) | Vision Transformer | 93.2% mAP | 48MB | ~12ms |
| CLIP (zero-shot) | OpenAI CLIP-ViT-B/32 | 87.0% (zero-shot) | 350MB | ~20ms |

**Recommended**: EfficientNet-B0 (multi-task) for balance of accuracy and speed

### 5.2 Model Architecture: Multi-Task Learning

```
Input: 128×256 RGB person crop
    │
    ▼ Backbone: EfficientNet-B0 (ImageNet pre-trained)
    │
    ▼ Feature Map: 1280-D
    │
    ├─ Upper garment head : FC(8)  + Softmax → upper type (8-class)
    ├─ Lower garment head : FC(6)  + Softmax → lower type (6-class)
    ├─ Full body head     : FC(5)  + Sigmoid → full outfit (multi-label)
    ├─ Sleeve head        : FC(4)  + Softmax → sleeve length
    └─ Collar head        : FC(6)  + Softmax → collar type
```

**Training strategy:**
- Pre-train on DeepFashion2 + FashionAI datasets
- Fine-tune on surveillance-specific dataset (low resolution, oblique angles)
- Multi-task loss: weighted sum of cross-entropy per head

### 5.3 Zero-Shot Extension (CLIP-based)

For unseen clothing categories not covered by the fixed taxonomy:

```javascript
const textPrompts = [
  'a person wearing a red hoodie',
  'a person in a police uniform',
  'a person wearing a lab coat',
];
// CLIP computes similarity between image crop and text prompts
// → enables open-vocabulary clothing description
```

---

## 6. Two-Stage Pipeline

### 6.1 Pipeline Architecture

```
RTSP Frame (JPEG Buffer)
    │
    ▼ Primary Detection (YOLOv8n) — person bboxes
    │
    ▼ For each tracked person:
    │
    ├─ Extract upper body ROI (y: 10%–65% of bbox height)
    │     └─ Resize → 128×192 px
    │     └─ Clothing classifier → upper garment type + attributes
    │
    ├─ Extract lower body ROI (y: 45%–100% of bbox height)
    │     └─ Resize → 128×192 px
    │     └─ Clothing classifier → lower garment type + attributes
    │
    ├─ Extract full body ROI (full bbox)
    │     └─ Resize → 128×256 px
    │     └─ Full-body outfit detection (dress/jumpsuit/uniform)
    │
    ▼ Temporal smoothing (10-frame majority vote)
    │  → Prevent garment type flickering
    │
    ▼ Natural language description generation
    │  { upper: 'hoodie', lower: 'jeans' } → "후드티, 청바지"
    │
    ▼ Attach to tracked object and emit
```

### 6.2 Natural Language Description

```javascript
const clothDescriptions = {
  upper: {
    't-shirt': '티셔츠', 'shirt': '셔츠', 'hoodie': '후드티',
    'sweater': '스웨터', 'jacket': '재킷', 'coat': '코트',
    'vest': '조끼', 'uniform_top': '유니폼 상의',
  },
  lower: {
    'jeans': '청바지', 'trousers': '바지', 'shorts': '반바지',
    'skirt': '치마', 'leggings': '레깅스', 'uniform_bottom': '유니폼 하의',
  },
};

function generateDescription(cloth, color) {
  const parts = [];
  if (color?.upperBody?.primary) parts.push(colorKo[color.upperBody.primary]);
  if (cloth.upperGarment) parts.push(clothDescriptions.upper[cloth.upperGarment.type]);
  if (color?.lowerBody?.primary) parts.push(colorKo[color.lowerBody.primary]);
  if (cloth.lowerGarment) parts.push(clothDescriptions.lower[cloth.lowerGarment.type]);
  return parts.join(' ');
  // → "빨간 후드티, 파란 청바지"
}
```

---

## 7. Integration Requirements

### 7.1 Zone Configuration

```json
{
  "id": "zone-uuid",
  "name": "Staff Only Area",
  "type": "MONITOR",
  "targetClasses": ["human", "cloth"],
  "uniformPolicy": {
    "required": ["uniform_top", "uniform_bottom"],
    "alertOnViolation": true
  },
  "dwellThreshold": 10
}
```

### 7.2 Alert Schema Extension

```json
{
  "type": "loitering",
  "cameraId": "cam-01",
  "objectId": "uuid",
  "zoneName": "Staff Only Area",
  "dwellTime": 45.2,
  "appearance": {
    "upperGarment": { "type": "hoodie", "confidence": 0.87 },
    "lowerGarment": { "type": "jeans", "confidence": 0.92 },
    "description": "후드티, 청바지",
    "uniformCompliant": false
  },
  "timestamp": 1715678901234
}
```

### 7.3 Person Search API

```
GET /api/events?upperCloth=hoodie&lowerCloth=jeans&fromTime=2026-05-01
GET /api/events?fullOutfit=uniform_full&zone=entrance
```

---

## 8. Performance Requirements

### 8.1 Classification Accuracy

| Metric | Minimum | Target |
|---|---|---|
| Upper garment top-1 accuracy | ≥ 82% | ≥ 90% |
| Lower garment top-1 accuracy | ≥ 85% | ≥ 92% |
| Full outfit detection mAP | ≥ 78% | ≥ 88% |
| Attribute accuracy (sleeve/collar) | ≥ 80% | ≥ 88% |

### 8.2 Robustness

| Condition | Requirement |
|---|---|
| Camera elevation | 0°–60° |
| Minimum person height | 60px in 1080p |
| Lighting | 100–5,000 lux |
| Partial occlusion | Top 50% visible → upper analysis possible |
| Weather | Raingear, winter coat correctly classified |

### 8.3 Latency

| Stage | Maximum |
|---|---|
| Upper garment classification | < 5ms |
| Lower garment classification | < 5ms |
| Full body classification | < 6ms |
| **Total per person** | **< 16ms** |
| **10 persons, batched** | **< 20ms** |

---

## 9. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Garment type accuracy | 40% | Top-1 accuracy on DeepFashion2 + surveillance dataset |
| Attribute accuracy | 20% | Sleeve/collar/fit attribute classification |
| Robustness | 20% | Low-res, oblique, partial occlusion conditions |
| Latency | 15% | Batch efficiency on CPU and GPU |
| Integration | 5% | ONNX format, multi-task output format |

---

## 10. Appendix

### Appendix A: Benchmark Datasets

| Dataset | Focus | Instances |
|---|---|---|
| DeepFashion2 | Fashion item detection + classification | 491,895 items |
| FashionAI | Clothing key point + category | 245,000 images |
| ModaNet | Streetwear segmentation + category | 55,176 images |
| RAP v2 | Surveillance clothing attributes | 84,928 persons |
| PA-100K | Pedestrian attributes including clothing | 100,000 persons |

### Appendix B: Model File Placement

```
server/models/
├── yolov8n.onnx                    # Primary detection (existing)
└── cloth_classifier_efficientb0.onnx  # Clothing type + attribute classifier
```

### Appendix C: Uniform Detection Configuration

For sites requiring uniform compliance monitoring:

```json
{
  "uniformProfiles": [
    {
      "name": "Security Guard",
      "upper": ["uniform_top"],
      "lower": ["trousers", "uniform_bottom"],
      "color": { "upper": "black", "lower": "black" }
    },
    {
      "name": "Medical Staff",
      "upper": ["uniform_top"],
      "lower": ["trousers", "uniform_bottom"],
      "color": { "upper": ["white", "blue", "green"], "lower": ["white", "blue", "green"] }
    }
  ]
}
```

### Appendix D: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) | Person detection (upstream dependency) |
| [RFP_AI_Color_Analysis.md](RFP_AI_Color_Analysis.md) | Color analysis (complementary for full description) |
| [RFP_AI_Accessories_Detection.md](RFP_AI_Accessories_Detection.md) | Accessories (bag/glasses) |
| [RFP_LTS2026_Loitering_Tracking_System.md](RFP_LTS2026_Loitering_Tracking_System.md) | Parent system RFP |

---

> **END OF DOCUMENT — LTS-2026-AI-06**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*
