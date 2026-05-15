# REQUEST FOR PROPOSAL (RFP)
# AI Module — Hat & Head Accessory Detection

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-07 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `hat` |
| **Status** | Planned (not yet implemented) |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Hat & Head Accessory Taxonomy](#4-hat--head-accessory-taxonomy)
5. [Model Specification](#5-model-specification)
6. [Two-Stage Pipeline](#6-two-stage-pipeline)
7. [Integration Requirements](#7-integration-requirements)
8. [Performance Requirements](#8-performance-requirements)
9. [Evaluation Criteria](#9-evaluation-criteria)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Hat & Head Accessory Detection AI Module**, which detects and classifies head-worn items (hats, helmets, caps) from detected persons in surveillance video. The module operates on head ROI crops extracted from primary person detection and serves as both a person description attribute and a safety compliance monitoring tool within the LTS-2026 Loitering Detection & Tracking System.

### 1.2 Scope

- Head accessory detection and classification: 8 hat/helmet categories
- Safety helmet compliance monitoring (construction sites, factories)
- Head accessory as person description attribute (cap, hood, hat)
- Integration as a zone-level attribute: `"targetClasses": ["hat"]`
- Shared head ROI pipeline with mask detection ([RFP_AI_Mask_Detection.md](RFP_AI_Mask_Detection.md)) and face recognition ([RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md))

### 1.3 Zone Target Key

Zones configured with `"targetClasses": ["hat"]` activate head accessory detection for all persons in the zone. Particularly useful for:
- Safety zone compliance: alert if no helmet detected
- Person description enrichment: "person in red baseball cap"
- Identity obfuscation detection: alert on hooded persons in restricted zones

---

## 2. Use Cases

| Use Case | Zone Config | Alert Condition |
|---|---|---|
| Safety helmet compliance | `["human", "hat"]` | Worker without hardhat in construction zone |
| Suspicious person (hooded) | `["human", "hat"]` | Hooded person loitering at night |
| Person description | `["human", "hat", "color"]` | "Blue baseball cap, gray hoodie" |
| Sports facility | `["hat"]` | Helmet required for bike/skate zone |
| Factory clean room | `["hat"]` | Required hair net / cap compliance |
| VIP / Uniform detection | `["hat"]` | Police/military cap as uniform marker |

---

## 3. Technical Requirements

### 3.1 Detection Capability

| Requirement | Specification |
|---|---|
| Target | All head-worn accessories (hats, helmets, hoods, hair nets) |
| Minimum head size | 25×25 pixels in 1080p |
| Simultaneous persons | Up to 50 per frame |
| Detection speed | Real-time at 10 FPS |
| Face angle tolerance | 0°–70° yaw (profile view) |
| Overlap handling | Detect when hat partially overlaps face |

### 3.2 Input Specifications

| Stage | Input | Resize Target |
|---|---|---|
| Person detection | Full JPEG frame | — |
| Head ROI extraction | Top 25–35% of person bbox | 96×96 px |
| Model input | Normalized head crop | 96×96 px |

### 3.3 Output Specifications

```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "hat": {
    "worn": true,
    "type": "baseball_cap",
    "confidence": 0.91,
    "color": "red",
    "headBbox": { "x": 108, "y": 52, "width": 44, "height": 42 },
    "safetyCompliant": null
  },
  "isLoitering": false,
  "dwellTime": 12.5
}
```

---

## 4. Hat & Head Accessory Taxonomy

### 4.1 Detection Classes

| ID | Class | Korean | Description | Safety |
|---|---|---|---|---|
| 0 | `no_hat` | 맨머리 | No head covering | — |
| 1 | `baseball_cap` | 야구모자 | Forward, backward, sideways cap | No |
| 2 | `beanie` | 비니 | Knit beanie/winter hat | No |
| 3 | `helmet_hard` | 안전모 | Construction/industrial hardhat | **Safety item** |
| 4 | `helmet_bike` | 자전거 헬멧 | Bicycle/motorcycle helmet | **Safety item** |
| 5 | `hood_up` | 후드 착용 | Hoodie with hood raised | Suspicious |
| 6 | `hat_wide` | 챙 넓은 모자 | Sun hat, fedora, cowboy hat | No |
| 7 | `hair_net` | 위생모 | Hygiene hair net/cap | **Safety item** |

### 4.2 Extended Classes (Optional)

| ID | Class | Korean | Use Case |
|---|---|---|---|
| 8 | `beret` | 베레모 | Military/artistic beret |
| 9 | `turban` | 터번 | Religious/cultural head covering |
| 10 | `face_shield_hat` | 안면보호 헬멧 | Full face shield (welding, grinding) |
| 11 | `hairband` | 헤어밴드 | Non-covering head accessory |
| 12 | `police_cap` | 경찰 모자 | Law enforcement uniform cap |
| 13 | `chef_hat` | 쉐프 모자 | Food service/kitchen hat |

### 4.3 Safety Classification

| Hat Type | Safety Zone Compliant | Recommendation |
|---|---|---|
| `helmet_hard` | Yes | Required for construction zones |
| `helmet_bike` | Yes | Required for sports/cycling zones |
| `hair_net` | Yes | Required for food/medical zones |
| `no_hat` | **No** | Alert in safety zones |
| `baseball_cap` | No | Alert in hard hat zones |
| `hood_up` | No | Alert in identity-verification zones |

### 4.4 Suspicious Head Covering Detection

In security-sensitive zones, the following combinations trigger alerts:

```javascript
const SUSPICIOUS_PATTERNS = [
  { hat: 'hood_up', timeOfDay: 'night', duration: 30 },     // hooded at night
  { hat: 'baseball_cap', facingCamera: false, duration: 60 }, // cap facing away
  { hat: 'no_hat', zone: 'hard_hat_required' },              // non-compliance
];
```

---

## 5. Model Specification

### 5.1 Head Detector (Stage 1)

Share with face detection module if available:

| Model | Task | Size | Latency |
|---|---|---|---|
| SCRFD-500M | Head/face detection | ~1MB | ~2ms |
| YOLOv8n-head | Head bounding box | ~6MB | ~5ms |
| Person head heuristic | Top 25% of person bbox | 0MB | ~0ms |

**Recommended**: Person-bbox heuristic (no additional model) for initial implementation; upgrade to YOLOv8n-head for improved accuracy at steep camera angles.

### 5.2 Hat Classification Model (Stage 2)

| Model | Architecture | Accuracy (8-class) | Size | Latency/crop |
|---|---|---|---|---|
| MobileNetV3-Small | MobileNetV3-S | 88.4% | 6MB | ~1.5ms |
| EfficientNet-B0 | EfficientNet-B0 | 92.1% | 20MB | ~4ms |
| ResNet-18 | ResNet-18 | 91.5% | 45MB | ~5ms |
| SqueezeNet 1.1 | SqueezeNet | 84.2% | 5MB | ~1ms |
| YOLOv8n-hat (single-stage) | Fine-tuned | 90.3% mAP | 6MB | ~8ms |

**Recommended**: MobileNetV3-Small for edge deployment; EfficientNet-B0 for server

### 5.3 Single-Stage Alternative (YOLOv8n-hat)

For direct hat detection on full frame without separate head ROI:

```
Input:  [1, 3, 640, 640]
Output: [N, 6] — x1, y1, x2, y2, confidence, class_id
Classes: 8 hat categories
```

Advantage: No separate person detection needed for hat-only zones.  
Disadvantage: Cannot associate hat with specific person objectId.

### 5.4 Color Integration

Reuse upper-body color classifier ([RFP_AI_Color_Analysis.md](RFP_AI_Color_Analysis.md)) applied to the head crop for hat color:

```javascript
const hatColor = await colorClassifier.classify(headCrop, { region: 'hat' });
// → { primary: 'red', confidence: 0.84 }
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
    ├─ Head ROI extraction
    │     Method A: heuristic (top 30% of person bbox)
    │     Method B: YOLOv8n-head or SCRFD-500M
    │
    ├─ Hat Classification (MobileNetV3-Small)
    │     Input: 96×96 head crop
    │     Output: { type, confidence }
    │
    ├─ Hat Color (EfficientNet-B0 color head, optional)
    │     Input: same 96×96 crop
    │     Output: { color, confidence }
    │
    ├─ Safety Compliance Check
    │     if zone.safetyPolicy === 'hardhat_required':
    │       if hat.type !== 'helmet_hard': emit 'safety_violation'
    │
    ▼ Temporal smoothing (majority vote over 10 frames)
    │  → Stable hat type (no flickering)
    │
    ▼ Attach to tracked object and emit
```

### 6.2 Head ROI Extraction (Heuristic)

```javascript
function extractHeadRoi(personBbox) {
  const headHeight = personBbox.height * 0.28;
  return {
    x:      personBbox.x + personBbox.width  * 0.10,
    y:      personBbox.y - headHeight * 0.10,  // include hat above head line
    width:  personBbox.width  * 0.80,
    height: headHeight * 1.20,                 // extra margin for tall hats
  };
}
```

### 6.3 Shared Head ROI Optimization

When multiple head-based modules are active (hat + mask + face), the head ROI is extracted once and shared:

```javascript
// Pipeline optimization: extract head ROI once per person
const headCrop = extractHeadRoi(personBbox);
const [hatResult, maskResult] = await Promise.all([
  hatClassifier.classify(headCrop),
  maskClassifier.classify(headCrop),
]);
```

---

## 7. Integration Requirements

### 7.1 Zone Configuration with Safety Policy

```json
{
  "id": "construction-zone-uuid",
  "name": "Construction Site A",
  "type": "MONITOR",
  "targetClasses": ["human", "hat"],
  "safetyPolicy": {
    "hatRequired": "helmet_hard",
    "alertOnViolation": true,
    "graceperiodSec": 5
  },
  "dwellThreshold": 5
}
```

### 7.2 Alert Schema

```json
{
  "type": "safety_violation",
  "subtype": "no_hardhat",
  "cameraId": "cam-construction",
  "objectId": "track-uuid",
  "zoneId": "construction-zone-uuid",
  "zoneName": "Construction Site A",
  "hatStatus": "baseball_cap",
  "hatConfidence": 0.89,
  "requiredHat": "helmet_hard",
  "dwellTime": 12.5,
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "timestamp": 1715678901234
}
```

### 7.3 Socket.IO Detection Extension

```json
{
  "objectId": "uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "hat": {
    "type": "helmet_hard",
    "confidence": 0.94,
    "color": "yellow",
    "safetyCompliant": true
  },
  "mask": { "status": "no_mask", "confidence": 0.88 },
  "isLoitering": false,
  "dwellTime": 6.2
}
```

---

## 8. Performance Requirements

### 8.1 Classification Accuracy

| Metric | Minimum | Target |
|---|---|---|
| Overall accuracy (8-class) | ≥ 87% | ≥ 93% |
| `no_hat` accuracy | ≥ 93% | ≥ 97% |
| `helmet_hard` precision | ≥ 92% | ≥ 97% |
| `helmet_hard` recall | ≥ 90% | ≥ 96% |
| `hood_up` accuracy | ≥ 85% | ≥ 92% |
| False safety alert rate | ≤ 3% | ≤ 1% |

### 8.2 Robustness

| Condition | Requirement |
|---|---|
| Camera angle | 0°–70° (elevation: 0°–60°) |
| Minimum head size | 25×25 pixels |
| Lighting | 50–10,000 lux + IR night mode |
| Head orientation | Frontal to near-profile (70° yaw) |
| Hat color variation | Invariant to hat color (not color-dependent) |
| Partial hat visibility | Detect when 50%+ of hat visible |

### 8.3 Latency Budget

| Component | Maximum |
|---|---|
| Head ROI extraction (heuristic) | < 0.5ms |
| Hat classification | < 2ms |
| Hat color estimation | < 2ms |
| **Total per person** | **< 5ms** |
| **10 persons, batched** | **< 8ms** |

---

## 9. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Classification accuracy | 40% | 8-class accuracy on HAT-1K + surveillance test set |
| Safety helmet precision/recall | 30% | Critical: `helmet_hard` false negative rate |
| Robustness | 15% | Steep angle, night, small head size scenarios |
| Latency | 10% | Per-person and batched frame latency |
| Integration | 5% | Head ROI sharing, ONNX format |

---

## 10. Appendix

### Appendix A: Benchmark Datasets

| Dataset | Focus | Size |
|---|---|---|
| HAT-1K (internal target) | Surveillance hat detection | 1,000+ annotated frames |
| Open Images V7 (subset) | Hat/helmet detection | ~50,000 hat instances |
| SHWD (Safety Helmet Wearing Dataset) | Hardhat/no-hardhat | 7,581 images |
| HardHat Dataset (Kaggle) | Construction safety | ~7,000 images |
| PA-100K subset | Pedestrian hat attributes | ~30,000 persons |

### Appendix B: Model File Placement

```
server/models/
├── yolov8n.onnx              # Primary detection (existing)
├── scrfd_500m.onnx           # Head detection (optional, shared with face/mask)
└── hat_classifier.onnx      # Hat type classifier (MobileNetV3-Small)
```

### Appendix C: Safety Policy Configuration

```json
{
  "safetyPolicies": {
    "construction": {
      "required": ["helmet_hard"],
      "alertOnViolation": true,
      "exemptions": ["visitor_badge"]
    },
    "food_processing": {
      "required": ["hair_net"],
      "alertOnViolation": true
    },
    "cycling_zone": {
      "required": ["helmet_bike"],
      "alertOnViolation": false,
      "warnOnViolation": true
    }
  }
}
```

### Appendix D: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) | Person detection (upstream dependency) |
| [RFP_AI_Mask_Detection.md](RFP_AI_Mask_Detection.md) | Mask detection (shares head ROI pipeline) |
| [RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md) | Face detection (shares head ROI) |
| [RFP_AI_Color_Analysis.md](RFP_AI_Color_Analysis.md) | Color analysis (hat color) |
| [RFP_LTS2026_Loitering_Tracking_System.md](RFP_LTS2026_Loitering_Tracking_System.md) | Parent system RFP |

---

> **END OF DOCUMENT — LTS-2026-AI-07**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*
