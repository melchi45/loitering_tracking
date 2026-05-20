# Adaptive Multi-Feature Loitering Detection System

## Overview

This document defines the implementation direction and RFP (Request For Proposal) for an AI-based Adaptive Multi-Feature Tracking system designed to detect human loitering behavior in RTSP-based video streams.

To address the limitations of existing Kalman Filter-based tracking systems:

- Human Detection
- Human Segmentation
- Appearance ReID
- Cloth / Accessory Detection
- Adaptive Kalman Filtering

a combined architecture is used.

---

# Problems with Existing Kalman Filter-based Loitering Detection

Existing structure:

```text
위치 기반 추적
→ 일정 시간 체류
→ Loitering 판단
```

Problems:

- Detection jitter
- Tracking ID changes
- Occlusion occurs
- Re-appearing person recognized as different individual
- Increased false positives with slow movement
- Limitations of fixed Kalman parameters

In other words:

- Too sensitive, or
- Too insensitive

issues arise.

---

# Improvement Direction

## Core Idea

Rather than simple position tracking:

```text
위치 + 외형 + 행동 + 시간
```

are used together.

---

# Overall System Architecture

```text
RTSP Input
   ↓
Frame Capture
   ↓
Human Detection
   ↓
Human Segmentation
   ↓
Appearance Feature Extraction
   ↓
Accessory / Cloth Detection
   ↓
Kalman Motion Tracking
   ↓
ReID Association
   ↓
Behavior Analysis
   ↓
Loitering Detection
   ↓
Alert / Event API
```

---

# 1. Human Detection

## Purpose

Detect people in the video.

## Recommended Models

- YOLOv11
- RT-DETR
- YOLO-NAS

## Output Example

```json
{
  "bbox": [x1, y1, x2, y2],
  "confidence": 0.95
}
```

---

# 2. Human Segmentation

## Purpose

Isolate the actual person region inside the bounding box.

## Advantages

- Background removal
- Clothing separation
- Accessory analysis possible
- Partial Occlusion handling

## Recommended Models

- YOLO-Seg
- Segment Anything Model (SAM)
- Mask2Former

## Output

```text
person mask
```

---

# 3. Appearance Feature Extraction

## Purpose

Convert a person's appearance features into an embedding vector.

## Extracted Attributes

- Upper body color
- Lower body color
- Pattern
- Body type
- Bag
- Hat
- Accessories

## Example

```text
person_embedding[512]
```

---

# 4. Semantic Attribute Detection

## Purpose

Store appearance information as semantic metadata.

## Example

```json
{
  "upper_color": "red",
  "lower_color": "black",
  "bag": true,
  "hat": false
}
```

## Advantages

- Increased explainability
- Improved ReID accuracy
- Handles lighting changes

---

# 5. Kalman Motion Tracking

## Purpose

Predict a person's motion state.

## State Vector

```text
[x, y, w, h, vx, vy]
```

## Functions

- Position prediction
- Missed detection compensation
- Movement smoothing
- ID continuity maintenance

---

# 6. Adaptive Kalman Filter

## Problem

When using fixed noise parameters:

- Tracking loss with fast movement
- Excessive sensitivity in stationary state
- Errors in occlusion situations

may occur

---

# Improvement Methods

## Motion-based Dynamic Adjustment

- Rapid acceleration → increase process noise
- Stationary → decrease process noise

---

## Appearance Confidence-based Adjustment

When appearance matching confidence is low:

- Increase covariance
- Increase uncertainty

---

## Occlusion-based Adjustment

When occlusion occurs:

- Increase prediction weight
- Decrease measurement weight

---

# 7. Multi-Cue Association

## Purpose

Maintain Tracking IDs stably.

## Existing Method

```text
IOU 기반 매칭
```

## Improved Method

```text
Motion Similarity
+
Appearance Similarity
+
Cloth Similarity
+
Mask Similarity
+
Temporal Consistency
```

## Example

```text
Score =
0.4 × IOU
+
0.4 × Appearance
+
0.2 × Attribute
```

---

# 8. Loitering Detection

## Purpose

Detect behavior such as prolonged presence in a specific area or repeated visits.

---

# Recommended Detection Criteria

## Zone Dwell Time

Dwell time in a specific area

---

## Revisit Count

Number of repeated visits to the same area

---

## Low Velocity Pattern

Sustained low movement speed

---

## Circular Motion Pattern

Repeated movement path detection

---

# State Storage Example

```json
{
  "track_id": 101,
  "timestamp": 171000000,
  "bbox": [x1,y1,x2,y2],
  "embedding": [],
  "cloth_color": "black",
  "bag": true,
  "zone": "A",
  "dwell_time": 122
}
```

---

# Recommended Technology Stack

## Detection

- Ultralytics YOLO
- RT-DETR

---

## Segmentation

- SAM
- Mask2Former

---

# Tracking

- DeepSORT
- ByteTrack
- OC-SORT

---

# ReID

- FastReID
- TorchReID

---

# Backend

- Node.js
- Python AI Worker

---

# Streaming

- FFmpeg
- GStreamer

---

# Database

- PostgreSQL
- Redis
- Milvus / Qdrant

---

# Recommended Implementation Phases

# Phase 1

```text
YOLO + DeepSORT
```

Implement basic tracking

---

# Phase 2

Add appearance embedding

---

# Phase 3

Add cloth / accessory detection

---

# Phase 4

Apply Adaptive Kalman

---

# Phase 5

Add behavior analysis and loitering logic

---

# Performance Goals

| Item | Target |
|---|---|
| Detection FPS | 15~30 FPS |
| Tracking Accuracy | MOTA > 0.75 |
| ReID Accuracy | >85% |
| False Alarm | <10% |
| Multi-Person Tracking | Supported |

---

# RFP (Request For Proposal)

## Project Name

AI-based Adaptive Multi-Feature Loitering Detection System

---

# Project Purpose

Based on real-time RTSP video:

- Person detection
- Multi-object tracking
- Appearance ReID
- Adaptive Kalman Filtering

are used to build a system to detect:

- Loiterers
- Long-term dwellers
- Repeated visit patterns

---

# Key Requirements

## Input

- RTSP Stream
- H264/H265 support
- Multi-channel support

---

# Functional Requirements

## Human Detection

- Real-time detection
- Multi-person support
- Minimum 15 FPS

---

## Segmentation

- Generate person mask
- Handle partial occlusion

---

## Tracking

- Maintain Tracking ID
- Minimize ID switches
- Apply Kalman prediction

---

## Appearance ReID

Supported attributes:

- upper/lower clothes
- cloth color
- backpack
- hat
- accessory

---

## Adaptive Kalman

Dynamic parameter adjustment based on:

- motion variance
- occlusion
- appearance confidence

Adaptive covariance applied

---

## Loitering Detection

Multi-condition-based judgment:

- dwell time
- revisit count
- low velocity
- repetitive motion

---

# Event Output Example

```json
{
  "event": "loitering",
  "track_id": 15,
  "zone": "A1",
  "dwell_time": 240,
  "risk_score": 0.84
}
```

---

# Additional Recommended Features

## Heatmap

Visualize loitering hotspots

---

## Cross-Camera ReID

Track the same person across cameras

---

## Suspicious Score

Score behavior risk level

---

# Conclusion

This system goes beyond simple Kalman-based position tracking:

```text
Motion + Appearance + Behavior
```

targeting an Adaptive Intelligent Tracking architecture that combines all of the above.

Through this, the following can be achieved:

- Improved tracking stability
- Increased ReID accuracy
- Reduced false alarms
- Enhanced real-world environment adaptability
