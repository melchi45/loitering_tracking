# RTSP → WebRTC + Storage + Playback Architecture

## Overview
This document describes a unified architecture for:
- Live streaming (WebRTC)
- Storage (Video / Audio / Metadata)
- Playback (Recorded data)

---

## Full Architecture Diagram

```
RTSP Cameras (Video / Audio / Application RTP)
        │
        ▼
Stream Server (Single Processor)
  - RTSP ingest (multi-stream)
  - Capture (Video / Audio)
  - RTP parsing (Application)
  - AI / Analyzer
  - Stream split (tee)
        │
        ├─────────────── Live Path ───────────────┐
        │                                         │
        ▼                                         ▼
RTP Fan-out                                 Recording Pipeline
        │                                   - Video (H264/H265)
        ▼                                   - Audio (AAC/Opus)
WebRTC Bridge                               - Metadata(JSON)
(mediasoup / mediamtx / werift)              │
        │                                    ▼
        ▼                              Storage Layer
Clients (Live)                         - Object Storage (S3/MinIO)
(WebRTC Video/Audio/DataChannel)       - Metadata DB (PostgreSQL)


                    Playback Path
                    ▼
         Stored Media + Metadata
                    │
                    ▼
         Playback Server (HLS / WebRTC)
                    │
                    ▼
         Clients (Playback)
         - Video (seek)
         - Audio sync
         - Metadata overlay
```

---

## Key Components

### 1. Stream Server (Core Processor)
- Multi RTSP ingest
- Single pipeline processing
- Stream branching using tee
- Capture + analysis combined

---

### 2. Live Path

```
Stream Server → RTP → WebRTC → Client
```

- Ultra-low latency streaming
- RTP → SRTP conversion
- DataChannel for application data

---

### 3. Storage Path

#### Video / Audio
- Stored as MP4 segments
- No re-encoding (use original codec)
- Recommended: splitmuxsink (time-based split)

#### Metadata
- Extracted from Application RTP
- Stored in DB (JSON format)

Example:

```json
{
  "timestamp": 1718192000.123,
  "camera": "cam1",
  "event": "motion_detected",
  "confidence": 0.95
}
```

---

### 4. Storage Layer

#### Object Storage
- Video segments
- Audio segments

#### Database
- Event logs
- Timestamps
- Indexing for playback search

---

### 5. Playback Path

Inputs:
- Stored Video
- Stored Audio
- Metadata DB

#### Playback modes

1. HLS/DASH (standard)
2. WebRTC replay (low latency)
3. Hybrid (recommended)

---

## Core Design Principles

- Separate Live and Storage paths
- Use single ingest pipeline (GStreamer)
- Store media and metadata separately
- Synchronize using timestamps
- Use segmented recording for scalability

---

## Summary

This architecture enables:
- High performance multi-camera ingest
- Real-time WebRTC streaming
- Scalable recording system
- Searchable and synchronized playback

