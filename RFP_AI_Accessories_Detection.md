# REQUEST FOR PROPOSAL (RFP)
# AI Module — Accessories Detection

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-08 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `accessories` |
| **Status** | **✅ Phase-1 구현 완료 (COCO yolov8n 즉시 동작)** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Accessory Taxonomy](#4-accessory-taxonomy)
5. [Model Specification](#5-model-specification)
6. [Detection Pipeline](#6-detection-pipeline)
7. [Integration Requirements](#7-integration-requirements)
8. [Performance Requirements](#8-performance-requirements)
9. [Evaluation Criteria](#9-evaluation-criteria)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Accessories Detection AI Module**, which detects personal accessories (bags, luggage, glasses, umbrellas, jewelry, and other carried items) associated with detected persons in surveillance video. The module enriches person metadata with accessory information for re-identification, person search, abandoned item detection, and behavioral pattern analysis within the LTS-2026 Loitering Detection & Tracking System.

### 1.2 Scope

- Detection of 10 accessory categories carried by or worn by persons
- Association of accessories with specific tracked person objectIds
- **Abandoned item detection**: alert when accessory is left without an associated person
- Integration as a zone-level attribute: `"targetClasses": ["accessories"]`
- Complementary to clothing ([RFP_AI_Cloth_Analysis.md](RFP_AI_Cloth_Analysis.md)) and color ([RFP_AI_Color_Analysis.md](RFP_AI_Color_Analysis.md)) analysis

### 1.3 Zone Target Key

Zones configured with `"targetClasses": ["accessories"]` activate accessory detection for all persons. When combined with loitering detection, enables compound alerts: "Person with large backpack loitering at Gate C for 45 seconds."

---

## 2. Use Cases

| Use Case | Description | Priority |
|---|---|---|
| Abandoned item detection | Bag left without person nearby → security alert | **High** |
| Person search by accessory | "Person with red backpack near platform 3" | **High** |
| Person Re-ID | Backpack/bag as distinctive Re-ID feature | High |
| Suspicious item detection | Oversized bag in restricted zone | High |
| Stolen item tracking | Track bag associated with specific person | Medium |
| Person description | "Blue backpack, glasses, umbrella" → alert enrichment | Medium |
| Loss prevention | Alert when person leaves without carried item | Medium |
| Crowd analytics | Luggage density → gate crowding predictor | Low |

---

## 3. Technical Requirements

### 3.1 Detection Capability

| Requirement | Specification |
|---|---|
| Accessory categories | 10 types (see Section 4) |
| Detection approach | Object detection on full frame; associate to nearest person |
| Minimum item size | Backpack: 40×50px; Glasses: 15×8px in 1080p |
| Simultaneous items | Up to 50 accessories per frame |
| Person association | Link each detected accessory to closest person (IoU overlap) |
| Abandoned item | Detect accessory with no associated person for > N seconds |

### 3.2 Input Specifications

| Input | Description | Size |
|---|---|---|
| Full frame | Primary detector input | 1080p JPEG |
| Person bbox list | From YOLOv8n person detection | — |
| Accessory detector input | Letterboxed frame | 640×640 |

### 3.3 Output Specifications

```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "accessories": [
    {
      "type": "backpack",
      "confidence": 0.91,
      "bbox": { "x": 105, "y": 100, "width": 50, "height": 70 },
      "color": "blue"
    },
    {
      "type": "glasses",
      "confidence": 0.76,
      "bbox": { "x": 115, "y": 60, "width": 28, "height": 10 },
      "color": "black"
    }
  ],
  "abandonedItem": null,
  "isLoitering": true,
  "dwellTime": 44.8
}
```

---

## 4. Accessory Taxonomy

### 4.1 Carried Item Categories

| ID | Class | Korean | COCO ID | Notes |
|---|---|---|---|---|
| 0 | `backpack` | 배낭/백팩 | 24 | Standard backpack, school bag |
| 1 | `handbag` | 핸드백 | 26 | Purse, clutch, small bag |
| 2 | `suitcase` | 여행가방 | 28 | Rolling luggage, hard/soft case |
| 3 | `umbrella` | 우산 | 25 | Open or closed umbrella |
| 4 | `briefcase` | 서류가방 | — | Business case (COCO: handbag subset) |

### 4.2 Worn Accessory Categories

| ID | Class | Korean | COCO ID | Notes |
|---|---|---|---|---|
| 5 | `glasses` | 안경 | — | Eyeglasses, sunglasses |
| 6 | `sunglasses` | 선글라스 | — | Tinted/sports sunglasses |
| 7 | `jewelry` | 액세서리 | — | Necklace, earrings, watch (visible) |
| 8 | `gloves` | 장갑 | — | Winter gloves, work gloves |
| 9 | `scarf` | 스카프/목도리 | — | Scarf, neck wrap |

### 4.3 Extended Categories (Optional)

| Class | Korean | Use Case |
|---|---|---|
| `shopping_bag` | 쇼핑백 | Retail environment |
| `sports_bag` | 스포츠백 | Athletic facility |
| `camera` | 카메라 | Tourist/surveillance context |
| `phone` | 핸드폰 | Person interaction context |
| `weapon_shape` | 형태적 위협물 | Security trigger (long object, etc.) |
| `stroller` | 유모차 | Family zone monitoring |

### 4.4 Abandoned Item Classification

An accessory is classified as "abandoned" when:

```
1. Accessory detected in frame
2. No person within proximity_threshold (e.g., 150px) for > abandon_timeout (e.g., 30s)
3. Accessory remains in same position (displacement < 20px)
```

| Priority Level | Abandon Timeout | Item Type | Zone |
|---|---|---|---|
| **HIGH** | 30s | `suitcase`, `backpack` | Airport, Station, Mall |
| **MEDIUM** | 60s | `handbag`, `briefcase` | Office, Store |
| **LOW** | 120s | `umbrella`, `shopping_bag` | Any |

---

## 5. Model Specification

### 5.1 Accessory Detector Options

#### Option A: YOLOv8n (COCO subset — already available)

Reuse the existing YOLOv8n model, which detects COCO accessory classes:

| COCO Class | ID | Detected by Existing Model |
|---|---|---|
| umbrella | 25 | Yes |
| backpack | 24 | Yes |
| handbag | 26 | Yes |
| tie | 27 | Yes (bonus) |
| suitcase | 28 | Yes |

**No additional model required** for these 5 categories. Extend `ENABLED_CLASSES` in `detection.js`:

```javascript
const ENABLED_CLASSES = {
  // existing
  0: 'person', 1: 'bicycle', 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck',
  // accessories (COCO classes)
  24: 'backpack', 25: 'umbrella', 26: 'handbag', 27: 'tie', 28: 'suitcase',
};
```

#### Option B: Dedicated Accessory Model

For glasses, jewelry, gloves, scarf (not in COCO):

| Model | Architecture | Categories | mAP@0.5 | Size | Latency |
|---|---|---|---|---|---|
| YOLOv8n-accessories (fine-tuned) | YOLOv8n | 10 classes | ~72% | ~6MB | ~10ms |
| YOLOv8s-accessories | YOLOv8s | 10 classes | ~81% | ~22MB | ~18ms |
| RT-DETR-R18-accessories | RT-DETR | 10 classes | ~78% | ~30MB | ~12ms |

#### Option C: Two-Stage (ROI Classifier for Worn Items)

For glasses/jewelry/scarf (small, worn — harder to detect with full-frame YOLO):

```
Stage 1: Person detection (existing YOLOv8n)
Stage 2: Face/head crop → glasses classifier (MobileNetV3)
Stage 3: Neck/upper-body crop → jewelry/scarf classifier (EfficientNet-B0)
```

### 5.2 Glasses Classifier (Stage 2 Model)

| Model | Accuracy | Size | Latency/crop |
|---|---|---|---|
| MobileNetV3-Small (3-class) | 93.2% | ~6MB | ~1.5ms |
| EfficientNet-B0 (3-class) | 95.8% | ~20MB | ~4ms |

Classes: `no_glasses`, `glasses`, `sunglasses`

Input: 64×64 face/head crop

### 5.3 Person-Accessory Association

```javascript
function associateAccessoryToPerson(accessoryBbox, personBboxes, threshold = 0.1) {
  // Find person whose bbox has maximum overlap with accessory bbox
  let bestPerson = null;
  let bestIou = threshold;
  for (const person of personBboxes) {
    const iou = computeIoU(accessoryBbox, expandBbox(person, 1.3));
    if (iou > bestIou) { bestIou = iou; bestPerson = person; }
  }
  return bestPerson;
}
```

---

## 6. Detection Pipeline

### 6.1 Full Pipeline Architecture

```
RTSP Frame (JPEG Buffer)
    │
    ▼ Primary Detection (YOLOv8n)
    │  persons: [{objectId, bbox, className:'person'}]
    │  accessories: [{bbox, className:'backpack'/'handbag'/...}]
    │  (COCO classes 24/25/26/27/28 already detected)
    │
    ├─ Optional Stage 2 (for glasses/jewelry/scarf):
    │    For each person:
    │      face crop → glasses classifier
    │      neck/shoulder crop → scarf/jewelry classifier
    │
    ▼ Person-Accessory Association
    │  Match each accessory bbox to nearest person by IoU
    │  Unmatched accessories → "unattended" candidate
    │
    ▼ Abandoned Item Tracker
    │  Track unattended accessories over time
    │  If accessory position stable for > abandon_timeout:
    │    emit 'abandoned_item' alert
    │
    ▼ Temporal smoothing (5-frame majority vote)
    │  → Stable accessory list per person
    │
    ▼ Attach accessories to tracked objects and emit
```

### 6.2 Abandoned Item State Machine

```
DETECTED
    │ No associated person for > proximity_threshold
    ▼
UNATTENDED (timer starts)
    │ Accessory stable (displacement < 20px)
    │ No person re-approaches within proximity_threshold
    ▼ (after abandon_timeout seconds)
ABANDONED → emit 'abandoned_item' alert
    │ Person re-approaches AND picks up item
    ▼
CLEARED
```

### 6.3 State Persistence

```javascript
class AbandonedItemTracker {
  // accessoryId → { bbox, firstSeenAloneAt, lastPositions, alertEmitted }
  _state = new Map();

  update(accessories, persons, timestamp) {
    for (const accessory of accessories) {
      const associated = associateAccessoryToPerson(accessory.bbox, persons);
      if (!associated) {
        this._trackUnattended(accessory, timestamp);
      } else {
        this._clearState(accessory.id);
      }
    }
  }
}
```

---

## 7. Integration Requirements

### 7.1 Zone Configuration

```json
{
  "id": "station-zone-uuid",
  "name": "Station Platform B",
  "type": "MONITOR",
  "targetClasses": ["human", "accessories"],
  "abandonedItemPolicy": {
    "enabled": true,
    "timeoutSec": 30,
    "alertPriority": "high",
    "itemTypes": ["suitcase", "backpack", "handbag"]
  },
  "dwellThreshold": 60
}
```

### 7.2 Loitering + Accessory Alert

```json
{
  "type": "loitering",
  "cameraId": "cam-platform",
  "objectId": "track-uuid",
  "zoneName": "Station Platform B",
  "dwellTime": 62.1,
  "appearance": {
    "accessories": [
      { "type": "backpack", "color": "black", "confidence": 0.92 },
      { "type": "suitcase", "color": "gray", "confidence": 0.88 }
    ],
    "description": "검정 배낭, 회색 캐리어"
  },
  "timestamp": 1715678901234
}
```

### 7.3 Abandoned Item Alert

```json
{
  "type": "abandoned_item",
  "cameraId": "cam-platform",
  "accessoryType": "suitcase",
  "accessoryColor": "black",
  "lastPersonId": "track-uuid",
  "lastPersonSeenAt": 1715678870000,
  "abandonedAt": 1715678901234,
  "abandonDurationSec": 31,
  "bbox": { "x": 320, "y": 400, "width": 80, "height": 100 },
  "zoneId": "station-zone-uuid",
  "zoneName": "Station Platform B",
  "priority": "high",
  "timestamp": 1715678901234
}
```

### 7.4 Person Search API

```
GET /api/events?accessory=backpack&accessoryColor=blue
GET /api/events?abandonedItem=suitcase&fromTime=2026-05-01
```

---

## 8. Performance Requirements

### 8.1 Detection Accuracy

| Accessory | Minimum mAP@0.5 | Target mAP@0.5 |
|---|---|---|
| backpack | ≥ 55% | ≥ 70% |
| handbag | ≥ 45% | ≥ 65% |
| suitcase | ≥ 60% | ≥ 75% |
| umbrella | ≥ 50% | ≥ 68% |
| glasses | ≥ 80% (classifier) | ≥ 90% |
| **Average (carried)** | **≥ 53%** | **≥ 70%** |

### 8.2 Abandoned Item Detection

| Metric | Minimum | Target |
|---|---|---|
| Detection rate (true abandoned) | ≥ 90% | ≥ 97% |
| False alarm rate (person nearby) | ≤ 5% | ≤ 1% |
| Temporal precision (within ±5s) | ≥ 85% | ≥ 95% |
| Person re-association accuracy | ≥ 88% | ≥ 95% |

### 8.3 Latency Budget

| Component | Maximum |
|---|---|
| COCO accessory detection (shared with person) | +0ms (same model pass) |
| Person-accessory association | < 1ms |
| Glasses classifier (optional) | < 2ms/person |
| Abandoned item tracking | < 1ms |
| **Total accessory overhead** | **< 5ms/frame** |

### 8.4 Robustness

| Condition | Requirement |
|---|---|
| Partial occlusion | Detect backpack when 60%+ visible |
| Camera angle | 0°–60° elevation |
| Item size variation | Detect large suitcase AND small glasses |
| Crowd scenes | Associate accessory to correct person in crowd |
| Night / IR | Functional for backpack/suitcase size items |

---

## 9. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Carried item detection (mAP) | 30% | COCO + accessory-specific benchmark |
| Abandoned item detection | 30% | True detection rate + false alarm rate |
| Person-accessory association | 20% | Correct ownership assignment in crowd |
| Latency | 10% | Overhead on top of primary detection pipeline |
| Integration | 10% | ONNX format, COCO class reuse, API compatibility |

---

## 10. Appendix

### Appendix A: COCO Accessory Classes (Already Supported)

| COCO ID | Class | Supported by YOLOv8n |
|---|---|---|
| 24 | backpack | Yes |
| 25 | umbrella | Yes |
| 26 | handbag | Yes |
| 27 | tie | Yes |
| 28 | suitcase | Yes |

**Action**: Add COCO classes 24/25/26/27/28 to `ENABLED_CLASSES` in `detection.js` — no new model required for baseline implementation.

### Appendix B: Model File Placement

```
server/models/
├── yolov8n.onnx                        # Primary detection (COCO accessories included)
├── glasses_classifier.onnx             # Glasses/sunglasses/no-glasses (optional)
└── accessories_yolov8n_finetune.onnx   # Extended accessory model (optional)
```

### Appendix C: Quick-Start Implementation

Minimum viable implementation (no new model):

```javascript
// server/src/services/detection.js
const ENABLED_CLASSES = {
  // Existing
  0: 'person', 1: 'bicycle', 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck',
  // Add: COCO accessories (zero additional inference cost)
  24: 'backpack', 25: 'umbrella', 26: 'handbag', 27: 'tie', 28: 'suitcase',
};

// server/src/services/behaviorEngine.js
const TARGET_CLASS_MAP = {
  human:       ['person'],
  vehicle:     ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  accessories: ['backpack', 'umbrella', 'handbag', 'tie', 'suitcase'],
};
```

This enables accessories zone filtering immediately with zero model changes.

### Appendix D: Benchmark Datasets

| Dataset | Focus | Instances |
|---|---|---|
| COCO val2017 | backpack/handbag/umbrella/suitcase | ~45,000 items |
| OpenImages V7 | Accessories subset | ~120,000 accessory instances |
| SIXray | Security X-ray items | 1,059,231 images |
| AVSS 2007 | Abandoned luggage video | Video benchmark |
| i-LIDS (UK) | Abandoned baggage | 500 sequences |

### Appendix E: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) | Person detection (upstream dependency) |
| [RFP_AI_Color_Analysis.md](RFP_AI_Color_Analysis.md) | Accessory color attribute |
| [RFP_AI_Cloth_Analysis.md](RFP_AI_Cloth_Analysis.md) | Clothing analysis (complementary) |
| [RFP_AI_Hat_Detection.md](RFP_AI_Hat_Detection.md) | Hat detection (head accessory) |
| [RFP_LTS2026_Loitering_Tracking_System.md](RFP_LTS2026_Loitering_Tracking_System.md) | Parent system RFP |

### Appendix E: Open Source Model Research (2026-05)

#### ✅ Phase-1: COCO yolov8n.onnx로 즉시 구현 완료

기존 `yolov8n.onnx` (COCO 80클래스)는 이미 accessories 클래스를 포함합니다.
`server/src/services/detection.js`의 `ENABLED_CLASSES`에 추가함으로써 **모델 추가 없이 즉시 동작**합니다.

| COCO Class ID | className | 설명 |
|---|---|---|
| 24 | `backpack` | 백팩/배낭 |
| 25 | `umbrella` | 우산 |
| 26 | `handbag` | 핸드백/숄더백 |
| 27 | `tie` | 넥타이 |
| 28 | `suitcase` | 여행가방/캐리어 |

#### Phase-2: 정밀 accessories 감지 (선택적)

| Source | URL | Notes |
|---|---|---|
| xxnw/Vehicle-attribute-recognition (GH) | https://github.com/xxnw/Vehicle-attribute-recognition | 차량 속성 |
| Event-AHU/OpenPAR (GH) | https://github.com/Event-AHU/OpenPAR | 가방/안경 포함 40+ 속성 |

#### Implementation Notes

```
서비스 파일: server/src/services/detection.js (수정 완료)
수정 내용:   ENABLED_CLASSES에 24(backpack), 25(umbrella), 26(handbag),
             27(tie), 28(suitcase) 추가

Zone targetClasses에 'accessories' 포함 시 behaviorEngine의
TARGET_CLASS_MAP['accessories']가 매핑하여 로이터링 로직 적용
출력: className: 'backpack' | 'umbrella' | 'handbag' | 'tie' | 'suitcase'
```

---

> **END OF DOCUMENT — LTS-2026-AI-08**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*
