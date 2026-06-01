# SRS_AI_Missing_Person_Detection.md

## Software Requirements Specification (SRS): Missing Person Detection

**문서 버전**: 1.0  
**작성일**: 2026-06-01  
**상태**: DRAFT → REVIEW  
**담당자**: Engineering Team  

---

## 1. Introduction

### 1.1 Purpose

이 SRS는 LTS-2026 배회 감지 시스템에 추가될 **실종자 감지(Missing Person Detection)** 모듈의 소프트웨어 요구사항을 정의합니다.

### 1.2 Scope

```
┌─────────────────────────────────────────────┐
│     LTS-2026 Missing Person Detection       │
├─────────────────────────────────────────────┤
│ • Backend Service (Node.js)                 │
│ • Database Layer (JSON/MongoDB)             │
│ • MCP Tool Integration                      │
│ • Test Suite (Unit + Integration + E2E)     │
└─────────────────────────────────────────────┘
```

### 1.3 Document Organization

1. Introduction (this section)
2. Overall Description
3. Detailed System Requirements
4. External Interface Requirements
5. System Features
6. Performance Requirements
7. Design Constraints
8. Quality Attributes
9. Test Requirements

---

## 2. Overall Description

### 2.1 System Architecture

```
┌─ RTSP Streams ────────────────────────┐
│                                       │
├─→ YOLOv8 Detection                   │
├─→ Face Detection & Embedding         │
├─→ ✨ Missing Person Matching         │ ← NEW
├─→ ByteTrack Tracking                 │
├─→ Alert Generation                   │
└─→ Socket.IO Distribution             │
      ↓
  ┌─────────────────────────────────┐
  │  MissingPersonService           │
  │  - DB Management                │
  │  - Face Matching                │
  │  - Event Generation             │
  └─────────────────────────────────┘
      ↓
  ┌─────────────────────────────────┐
  │  MCP Tools                      │
  │  - Register Missing Person      │
  │  - Search Missing Person        │
  │  - Get Detections               │
  │  - Update Status                │
  └─────────────────────────────────┘
      ↓
  ┌─────────────────────────────────┐
  │  LLM (Claude via MCP)           │
  │  Natural Language Queries        │
  └─────────────────────────────────┘
```

### 2.2 Major Components

| 컴포넌트 | 파일 위치 | 책임 |
|---------|---------|------|
| **MissingPersonService** | `server/src/services/missingPersonService.js` | 핵심 비즈니스 로직 |
| **MCP Tool** | `mcp-server/tools/missing-person.js` | LLM 인터페이스 |
| **API Routes** | `server/src/routes/missingPerson.js` | REST 엔드포인트 |
| **Socket Handler** | `server/src/socket/missingPersonHandler.js` | 실시간 이벤트 |
| **Database** | `server/src/db.js` (확장) | 데이터 영속성 |
| **Tests** | `test/api/missing-person.test.js` | 검증 |

---

## 3. Detailed System Requirements

### 3.1 Data Storage Requirements

#### 3.1.1 Missing Person Record

```javascript
Type: MissingPerson
{
  id: string (UUID v4),
  name: string (required, max 100),
  age: number (0~150),
  gender: enum ['M', 'F', 'OTHER'],
  description: string (max 500),
  photoUrl: string (https URL or base64),
  faceEmbedding: Float32Array (512 dimensions),
  reportedDate: ISO8601 timestamp,
  status: enum ['MISSING', 'FOUND', 'UNCONFIRMED'],
  priority: enum ['LOW', 'MEDIUM', 'HIGH'],
  contacts: {
    name: string,
    phone: string (regex: \d{10,15}),
    relation: string
  },
  metadata: {
    createdBy: string (email),
    createdAt: ISO8601,
    updatedAt: ISO8601,
    tags: string[]
  }
}
```

#### 3.1.2 Detection Event Record

```javascript
Type: MissingPersonDetection
{
  id: string (UUID v4),
  missingPersonId: string (FK → MissingPerson),
  cameraId: string (FK → Camera),
  frameId: number,
  timestamp: ISO8601,
  similarity: number (0.0 ~ 1.0),
  boundingBox: {
    x: number,
    y: number,
    width: number,
    height: number
  },
  trackingId: string (ByteTrack ID),
  status: enum ['PENDING', 'CONFIRMED', 'FALSE_POSITIVE'],
  metadata: {
    alertSent: boolean,
    alertedAt: ISO8601,
    confirmedBy: string (email, optional),
    notes: string (optional)
  }
}
```

### 3.2 API Requirements

#### 3.2.1 REST Endpoints

```javascript
// 실종자 관리
POST   /api/missing-persons              // 실종자 등록
GET    /api/missing-persons              // 실종자 목록 조회
GET    /api/missing-persons/:id          // 실종자 상세 조회
PUT    /api/missing-persons/:id          // 실종자 정보 수정
DELETE /api/missing-persons/:id          // 실종자 삭제
PATCH  /api/missing-persons/:id/status   // 상태 변경

// 감지 이벤트 조회
GET    /api/missing-persons/detections   // 감지 이벤트 목록
GET    /api/missing-persons/:id/detections  // 특정 실종자의 감지 이벤트
PUT    /api/detections/:id/confirm       // 감지 확인
PUT    /api/detections/:id/reject        // 오경보 거부

// 통계
GET    /api/missing-persons/stats        // 통계 조회
```

#### 3.2.2 Request/Response Examples

```javascript
// POST /api/missing-persons
Request Body:
{
  name: "김철수",
  age: 45,
  gender: "M",
  description: "180cm, 검은색 상의, 회색 바지",
  photoUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  reportedDate: "2026-06-01T10:30:00Z",
  priority: "HIGH",
  contacts: {
    name: "이순신",
    phone: "010-1234-5678",
    relation: "아들"
  }
}

Response (201 Created):
{
  id: "mp-1234567890",
  name: "김철수",
  faceEmbedding: [0.123, 0.456, ...],
  status: "MISSING",
  createdAt: "2026-06-01T10:35:00Z"
}
```

### 3.3 Processing Requirements

#### 3.3.1 Face Matching Algorithm

```
Input: detected_embedding (512D vector)
       missing_persons_db (1..N persons)

Algorithm:
1. For each missing_person in db:
   a. Calculate cosine_similarity(detected, stored)
   b. If similarity >= THRESHOLD (0.75):
      - confidence = 0.5 * similarity + 
                     0.3 * time_decay_factor +
                     0.2 * location_relevance
      - IF confidence >= CONFIDENCE_THRESHOLD (0.80):
        * Create detection event
        * Set status = PENDING
        * Trigger alert

2. Return: array of potential matches

Performance: O(n) where n = number of missing persons
            Must complete in < 500ms for 10,000 persons
```

#### 3.3.2 Real-time Processing Pipeline

```
Frame Input
    ↓
YOLO Detection (existing)
    ↓
Face Detection (existing)
    ↓
Face Embedding Extraction (existing)
    ↓
═════════════════════════════════════
Missing Person Matching (NEW)
  - Load missing persons from cache
  - Calculate similarities
  - Filter matches (sim >= 0.75)
  - Calculate confidence scores
  - Generate detection events
═════════════════════════════════════
    ↓
Alert Service (enhanced)
    ↓
Socket.IO Broadcast
```

### 3.4 MCP Tool Requirements

#### 3.4.1 Tool Definitions

```javascript
// Tool 1: Register Missing Person
Name: mcp_lts_register_missing_person
Input: {
  name: string (required),
  age: number (required),
  gender: string (required),
  description: string (required),
  photoUrl: string (required),
  contacts: object (required),
  priority: string (default: 'MEDIUM')
}
Output: {
  id: string,
  status: string,
  createdAt: timestamp
}

// Tool 2: Search Missing Person
Name: mcp_lts_search_missing_person
Input: {
  query: string (name/age/description),
  limit: number (default: 10)
}
Output: {
  results: Array<MissingPerson>,
  count: number
}

// Tool 3: Get Missing Person Detections
Name: mcp_lts_get_missing_person_detections
Input: {
  date: ISO8601 date,
  missingPersonId?: string,
  status?: string,
  limit?: number
}
Output: {
  detections: Array<Detection>,
  summary: {
    total: number,
    confirmed: number,
    pending: number
  }
}

// Tool 4: Update Missing Person Status
Name: mcp_lts_update_missing_person_status
Input: {
  missingPersonId: string (required),
  status: string ('FOUND'|'UNCONFIRMED') (required),
  notes?: string
}
Output: {
  id: string,
  status: string,
  updatedAt: timestamp
}
```

#### 3.4.2 MCP Server Integration

```javascript
// mcp-server/tools/missing-person.js structure
module.exports = {
  tools: [
    {
      name: 'mcp_lts_register_missing_person',
      description: '...',
      inputSchema: { ... },
      execute: async (input) => { ... }
    },
    {
      name: 'mcp_lts_search_missing_person',
      description: '...',
      inputSchema: { ... },
      execute: async (input) => { ... }
    },
    // ... more tools
  ],
  resources: {
    'missing-persons://': {
      readAsText: async (uri) => { ... }
    }
  }
};
```

---

## 4. External Interface Requirements

### 4.1 Socket.IO Events

```javascript
// Server → Client
io.emit('missingPersonDetected', {
  detectionId: string,
  missingPersonId: string,
  name: string,
  cameraId: string,
  timestamp: ISO8601,
  similarity: number,
  priority: string,
  boundingBox: object,
  photoUrl: string
});

// Status update
io.emit('missingPersonStatusChanged', {
  missingPersonId: string,
  status: string,
  updatedAt: ISO8601
});
```

### 4.2 Database Interface

```javascript
// Storage/lts.json structure
{
  "missing_persons": [
    { /* MissingPerson records */ }
  ],
  "missing_person_detections": [
    { /* Detection records */ }
  ],
  "missing_person_stats": {
    "total_registered": 5,
    "total_detections_today": 12,
    "by_priority": { "HIGH": 3, "MEDIUM": 2, "LOW": 0 }
  }
}
```

---

## 5. System Features

### 5.1 Feature 1: Missing Person Registration

```gherkin
Feature: Register Missing Person
  Background:
    Given Admin user is authenticated
    And Missing Person form is displayed

  Scenario: Successful registration
    When Admin uploads face photo
    And fills in all required fields
    And clicks "Register"
    Then system extracts face embedding
    And stores to database
    And returns success message with ID
```

### 5.2 Feature 2: Real-time Detection

```gherkin
Feature: Real-time Missing Person Detection
  Background:
    Given at least one missing person registered
    And RTSP stream is flowing

  Scenario: Person detected in frame
    When person enters camera view
    And face embedding matches missing person (sim >= 0.75)
    Then detection event is created
    And operator sees alert in dashboard
    And Socket.IO broadcasts to all clients
```

### 5.3 Feature 3: LLM Natural Language Query

```gherkin
Feature: Query Missing Persons via LLM
  Background:
    Given LLM has access to MCP tools
    And user asks natural language question

  Scenario: "오늘 김철수를 봤나?"
    When LLM receives query
    And calls searchMissingPerson('김철수')
    And calls getMissingPersonDetections(today)
    Then LLM generates natural response
    And includes detection locations/times/confidence
```

---

## 6. Performance Requirements

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Face Matching Latency** | < 500ms | Per frame |
| **Detection Processing** | < 100ms | End-to-end |
| **API Response Time** | < 200ms | p95 |
| **DB Query Time** | < 50ms | p95 |
| **Memory Footprint** | < 500MB | 10K missing persons |
| **Throughput** | 100 faces/sec | Concurrent |
| **Availability** | 99.5% | Monthly uptime |

---

## 7. Design Constraints

| 제약사항 | 설명 |
|---------|------|
| **Language** | Node.js CommonJS (ES modules forbidden) |
| **Framework** | Express.js |
| **DB** | JSON file (`storage/lts.json`) or MongoDB Atlas |
| **Async Pattern** | async/await only (no Promise chains) |
| **FaceNet Model** | 512-dimensional embedding |
| **Face Detection** | YOLOv8 face detector |
| **Similarity Metric** | Cosine similarity |
| **Socket.IO** | Version 4.x |

---

## 8. Quality Attributes

### 8.1 Reliability

- ✅ Error handling with fallback mechanisms
- ✅ Graceful degradation if matching fails
- ✅ Data persistence with backup

### 8.2 Security

- ✅ Admin-only access to registration
- ✅ API authentication (JWT tokens)
- ✅ Input validation on all endpoints
- ✅ Audit logging of all modifications
- ✅ Data encryption at rest (AES-256)

### 8.3 Maintainability

- ✅ Clear separation of concerns
- ✅ Comprehensive error messages
- ✅ Detailed logging at key points
- ✅ Code comments for complex logic
- ✅ Modular service architecture

### 8.4 Usability

- ✅ Intuitive dashboard UI
- ✅ Clear alert indicators
- ✅ One-click confirmation/rejection
- ✅ Responsive design

---

## 9. Test Requirements

### 9.1 Unit Tests

```javascript
// test/api/missing-person.test.js

describe('MissingPersonService', () => {
  test('Register missing person - success', () => {});
  test('Calculate similarity - valid embeddings', () => {});
  test('Match faces - above threshold', () => {});
  test('Create detection event', () => {});
  // ... more tests
});
```

### 9.2 Integration Tests

```javascript
describe('Missing Person Detection Pipeline', () => {
  test('Full pipeline: register → detect → alert', () => {});
  test('Cross-camera tracking', () => {});
  test('MCP tool execution', () => {});
  // ... more tests
});
```

### 9.3 E2E Tests

```javascript
describe('End-to-End Missing Person Detection', () => {
  test('User registers → System detects → Alert sent', () => {});
  test('LLM queries → MCP tools → Results', () => {});
  // ... more tests
});
```

### 9.4 Performance Tests

```javascript
test('Performance: 10K missing persons - < 500ms', () => {});
test('Throughput: 100 faces/sec', () => {});
test('Memory: < 500MB', () => {});
```

---

## 10. Acceptance Criteria

- ✅ All FR and NFR requirements met
- ✅ Unit test coverage > 80%
- ✅ Integration tests all passing
- ✅ E2E tests all passing
- ✅ Performance benchmarks met
- ✅ Security review approved
- ✅ Documentation complete
- ✅ Code review approved

---

## Appendix A: Glossary

| 용어 | 정의 |
|------|------|
| **Embedding** | 512차원 벡터로 표현된 얼굴 특징 |
| **Similarity** | 코사인 유사도 (0~1) |
| **False Positive** | 잘못된 감지 (실제로는 다른 사람) |
| **Confidence** | 감지 신뢰도 점수 |
| **Re-ID** | 여러 카메라에서 동일인 추적 |
| **MCP** | Model Context Protocol (LLM 연동) |

---

## Appendix B: References

- Design_AI_Missing_Person_Detection.md
- PRD_AI_Missing_Person_Detection.md
- Server Architecture: `.claude/CLAUDE.md`
- Face Recognition: Design_AI_Face_Recognition.md

---

**SRS ID**: SRS-MP-001  
**Status**: DRAFT (Awaiting Technical Review)  
**Last Updated**: 2026-06-01
