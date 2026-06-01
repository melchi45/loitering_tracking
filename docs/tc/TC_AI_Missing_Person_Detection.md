# TC_AI_Missing_Person_Detection.md

## Test Cases: Missing Person Detection System

**문서 버전**: 1.0  
**작성일**: 2026-06-01  
**상태**: ACTIVE  
**담당자**: QA Team  

---

## Executive Summary

이 문서는 **Missing Person Detection** 기능의 포괄적인 테스트 케이스를 정의합니다.

**범위**:
- Unit Tests (Service Logic)
- Integration Tests (API + DB + Pipeline)
- E2E Tests (Full Workflow)
- Performance Tests (Load + Throughput)

**목표**: 
- 요구사항 검증
- 버그 조기 발견
- 품질 보증 (품질 지표 > 95%)

---

## 1. Unit Test Cases

### 1.1 TC-U001: Register Missing Person - Valid Input

```gherkin
Test Case: TC-U001
Category: Unit / Missing Person Service
Title: Register Missing Person with Valid Input

Precondition:
  - System is running
  - missingPersonService is initialized
  - Valid face photo is prepared

Steps:
  1. Call missingPersonService.registerMissingPerson({
       name: "김철수",
       age: 45,
       gender: "M",
       description: "180cm, 검은색 상의",
       photoUrl: "data:image/jpeg;base64,...",
       priority: "HIGH",
       contacts: { ... }
     })

Expected Result:
  - Returns MissingPerson object with:
    * id (UUID)
    * faceEmbedding (512D array)
    * status = "MISSING"
    * createdAt timestamp

Pass Criteria:
  ✓ Object structure matches schema
  ✓ faceEmbedding length = 512
  ✓ status = "MISSING"
  ✓ DB record created
```

### 1.2 TC-U002: Register Missing Person - Invalid Input

```gherkin
Test Case: TC-U002
Category: Unit / Validation
Title: Reject Registration with Invalid Input

Precondition:
  - System is running
  - Invalid inputs are prepared

Test Data:
  | Input Field | Invalid Value | Expected Error |
  |-------------|---------------|---|
  | name | "" (empty) | ValidationError: name required |
  | age | 200 | ValidationError: age > 150 |
  | photo | invalid_base64 | ValidationError: invalid image |
  | phone | "12345" | ValidationError: invalid phone |

Steps:
  1. For each invalid input:
     a. Call registerMissingPerson(invalid_input)
     b. Catch error

Expected Result:
  - Throws appropriate ValidationError
  - Error message is descriptive
  - No DB record created

Pass Criteria:
  ✓ Error thrown for each invalid case
  ✓ Error type matches expected
  ✓ DB remains unchanged
```

### 1.3 TC-U003: Calculate Cosine Similarity

```gherkin
Test Case: TC-U003
Category: Unit / Face Matching
Title: Calculate Cosine Similarity Between Embeddings

Precondition:
  - Two face embeddings (512D vectors) prepared

Test Cases:
  1. Identical embeddings: similarity = 1.0
  2. Orthogonal embeddings: similarity ≈ 0.0
  3. Similar embeddings: similarity ≈ 0.92

Steps:
  1. embedding1 = [0.1, 0.2, ..., 512 dims]
  2. embedding2 = [0.11, 0.21, ..., 512 dims]
  3. similarity = calculateSimilarity(embedding1, embedding2)

Expected Result:
  - similarity value between 0.0 and 1.0
  - Calculation matches cosine formula

Pass Criteria:
  ✓ Result is within expected range
  ✓ Precision to 4 decimal places
```

### 1.4 TC-U004: Match Faces - Above Threshold

```gherkin
Test Case: TC-U004
Category: Unit / Face Matching Algorithm
Title: Detect Match When Similarity Exceeds Threshold

Precondition:
  - Missing person registered with embedding E1
  - Detected face with embedding E2
  - THRESHOLD = 0.75

Test Data:
  | E1 | E2 | Similarity | Expected |
  |----|----|-----------| ---------|
  | face1 | similar_to_face1 | 0.92 | MATCH ✓ |
  | face1 | different_face | 0.60 | NO MATCH ✗ |

Steps:
  1. Call matchFaces(detectedEmbedding)
  2. Iterate through missing persons DB
  3. Calculate similarities
  4. Filter matches (similarity >= 0.75)

Expected Result:
  - Returns array of matches
  - Each match includes:
    * missingPersonId
    * similarity score
    * confidence score

Pass Criteria:
  ✓ Correct matches identified
  ✓ No false negatives (when sim >= 0.75)
  ✓ False positive rate < 5%
```

### 1.5 TC-U005: Create Detection Event

```gherkin
Test Case: TC-U005
Category: Unit / Event Generation
Title: Create Detection Event with All Required Fields

Precondition:
  - Face match found (similarity 0.92)
  - Camera context available

Steps:
  1. Call createDetectionEvent({
       missingPersonId: "mp-001",
       cameraId: "cam-001",
       frameId: 6081,
       timestamp: Date.now(),
       similarity: 0.92,
       boundingBox: { x: 100, y: 50, w: 80, h: 120 },
       trackingId: "track-001"
     })

Expected Result:
  - Returns DetectionEvent object with:
    * id (UUID)
    * status = "PENDING"
    * alertSent = false
    * metadata.createdAt

Pass Criteria:
  ✓ All required fields present
  ✓ Timestamp is recent (within 1 second)
  ✓ Event persisted to DB
```

---

## 2. Integration Test Cases

### 2.1 TC-I001: Full Pipeline - Register to Alert

```gherkin
Test Case: TC-I001
Category: Integration / End-to-End Pipeline
Title: Full Pipeline from Registration to Alert

Precondition:
  - Server running
  - Socket.IO client connected
  - Test camera stream available

Steps:
  1. POST /api/missing-persons
     with valid data
     ⟹ Response: { id: "mp-001" }

  2. Inject test frame with person resembling mp-001

  3. Pipeline processes:
     a. YOLO detection
     b. Face extraction
     c. Embedding generation
     d. Missing person matching
        ⟹ Match found (similarity 0.92)
     e. Detection event creation
     f. Alert generation
     g. Socket.IO broadcast

  4. Verify alerts in database
  5. Check Socket.IO event received

Expected Result:
  - Detection event created with status PENDING
  - Socket.IO emitted 'missingPersonDetected'
  - Alert visible in monitoring dashboard
  - Event in storage/lts.json

Pass Criteria:
  ✓ All pipeline steps executed
  ✓ Event end-to-end latency < 500ms
  ✓ Alert reaches client within 1 second
  ✓ Data consistency maintained
```

### 2.2 TC-I002: API Endpoint - GET /api/missing-persons

```gherkin
Test Case: TC-I002
Category: Integration / API
Title: Retrieve All Missing Persons

Precondition:
  - 5 missing persons registered
  - API server running

Steps:
  1. GET /api/missing-persons

Expected Result:
  - Status 200 OK
  - Response:
    {
      results: Array[5],
      total: 5,
      pagination: { page: 1, limit: 50 }
    }
  - Each record contains: id, name, age, status

Pass Criteria:
  ✓ Correct count returned
  ✓ Pagination works
  ✓ Response time < 200ms
  ✓ All fields populated
```

### 2.3 TC-I003: API Endpoint - PUT Status Update

```gherkin
Test Case: TC-I003
Category: Integration / API
Title: Update Missing Person Status to FOUND

Precondition:
  - Missing person with id "mp-001" exists with status MISSING

Steps:
  1. PUT /api/missing-persons/mp-001/status
     Body: { status: "FOUND", notes: "Found at Seoul Station" }

Expected Result:
  - Status 200 OK
  - Response includes:
    { id: "mp-001", status: "FOUND", updatedAt: "..." }
  - DB updated
  - Socket.IO broadcast sent

Pass Criteria:
  ✓ Status changed in DB
  ✓ All clients notified
  ✓ Audit log recorded
```

### 2.4 TC-I004: MCP Tool - Search Missing Person

```gherkin
Test Case: TC-I004
Category: Integration / MCP
Title: MCP Tool - Search Missing Person by Name

Precondition:
  - MCP server initialized
  - Missing persons registered

Steps:
  1. Call MCP tool: mcp_lts_search_missing_person
     Input: { query: "김철수", limit: 10 }

Expected Result:
  - Returns array of matching persons
  - Includes: id, name, age, priority, lastDetected
  - Count <= limit

Pass Criteria:
  ✓ Correct persons found
  ✓ Ranking by relevance
  ✓ Response time < 100ms
```

### 2.5 TC-I005: MCP Tool - Get Today's Detections

```gherkin
Test Case: TC-I005
Category: Integration / MCP
Title: MCP Tool - Get Today's Missing Person Detections

Precondition:
  - Multiple detections recorded today
  - MCP tool available

Steps:
  1. Call MCP tool: mcp_lts_get_missing_person_detections
     Input: { date: "2026-06-01", limit: 50 }

Expected Result:
  - Returns array of today's detections
  - Each includes: missingPersonId, name, cameraId, similarity, time
  - Sorted by timestamp DESC

Pass Criteria:
  ✓ Only today's records returned
  ✓ All detections included
  ✓ Response time < 200ms
  ✓ Summary stats accurate
```

---

## 3. End-to-End Test Cases

### 3.1 TC-E001: LLM Query - Natural Language Question

```gherkin
Test Case: TC-E001
Category: E2E / LLM Integration
Title: LLM Responds to Natural Language Query

Precondition:
  - LLM (Claude) connected to MCP server
  - Missing persons registered
  - Today's detections recorded

Steps:
  1. User asks (via LLM): "오늘 47세 남성을 봤나?"
  
  2. LLM internally:
     a. Parses query ⟹ age: 47, gender: "M"
     b. Calls MCP: searchMissingPerson
     c. Gets matching persons: [mp-001, mp-003]
     d. Calls MCP: getMissingPersonDetections(today)
     e. Filters detections for those persons
     f. Generates natural response

Expected Result:
  - LLM response includes:
    * Confirmed matches found
    * Detection times and locations
    * Similarity scores
    * Action recommendations

Example Response:
  "네, 47세 남성 '김철수'가 오늘 3회 감지되었습니다.
   - 08:30 서울역 (유사도 92%)
   - 14:25 명동 카메라 5번 (유사도 88%)
   - 18:45 강남역 (유사도 95%)
   경찰에 신고하시기 바랍니다."

Pass Criteria:
  ✓ Query correctly interpreted
  ✓ MCP tools called appropriately
  ✓ Response accurate and actionable
  ✓ Natural language quality high
```

### 3.2 TC-E002: Cross-Camera Tracking

```gherkin
Test Case: TC-E002
Category: E2E / Tracking
Title: Person Tracked Across Multiple Cameras

Precondition:
  - Missing person registered
  - Multiple cameras covering journey path
  - Person passes through camera views

Steps:
  1. Frame 100: Person detected at Camera 1 (similarity 0.92)
     ⟹ Detection event 1 created
  
  2. Frame 200: Person detected at Camera 2 (similarity 0.88)
     ⟹ Detection event 2 created
     ⟹ System links to same tracking chain
  
  3. Frame 300: Person detected at Camera 3 (similarity 0.91)
     ⟹ Detection event 3 created
     ⟹ System continues tracking

Expected Result:
  - Trajectory reconstructed: Cam1 → Cam2 → Cam3
  - Timeline: 14:25 → 14:32 → 14:45
  - Direction/speed inferred
  - Next likely location predicted

Pass Criteria:
  ✓ All detections linked
  ✓ Timeline accurate
  ✓ Movement pattern logical
  ✓ Prediction reasonable
```

### 3.3 TC-E003: False Positive Rejection

```gherkin
Test Case: TC-E003
Category: E2E / Accuracy
Title: Operator Rejects False Positive Detection

Precondition:
  - False positive detection event created
  - Operator viewing dashboard

Steps:
  1. System detects similarity 0.76 (barely above threshold)
  
  2. Detection appears in pending queue
  
  3. Operator reviews snapshot + compares to registered photo
  
  4. Operator clicks "Not a match" button
  
  5. PUT /api/detections/det-001/reject
     Body: { status: "FALSE_POSITIVE", reason: "Different person" }

Expected Result:
  - Event status changes to FALSE_POSITIVE
  - Stored in rejection log
  - Similar future detections reduce confidence
  - Event hidden from active alerts

Pass Criteria:
  ✓ Status updated
  ✓ Log recorded
  ✓ Model learns from feedback
  ✓ Alert cleared from dashboard
```

---

## 4. Performance Test Cases

### 4.1 TC-P001: Face Matching Latency (10K Missing Persons)

```gherkin
Test Case: TC-P001
Category: Performance / Scalability
Title: Face Matching with 10,000 Missing Persons in DB

Precondition:
  - 10,000 missing persons registered
  - Embeddings cached in memory
  - Face embedding ready

Measurement Points:
  1. Start: timing.start()
  2. Call: matchFaces(detectedEmbedding)
  3. End: timing.end()
  4. Duration = timing.end - timing.start

Expected Result:
  - Duration: < 500ms (p95)
  - Throughput: > 100 faces/sec
  - Memory: < 500MB for all embeddings

Benchmark Criteria:
  ✓ Mean latency < 300ms
  ✓ P95 < 500ms
  ✓ P99 < 700ms
  ✓ Zero timeouts
```

### 4.2 TC-P002: API Throughput (Concurrent Queries)

```gherkin
Test Case: TC-P002
Category: Performance / Load
Title: API Handles 100 Concurrent Requests

Precondition:
  - API server running
  - Database available

Setup:
  - Launch 100 concurrent HTTP clients
  - Each client: GET /api/missing-persons

Expected Result:
  - All 100 requests complete successfully
  - Response time P95: < 200ms
  - Success rate: 100%
  - No memory leaks

Pass Criteria:
  ✓ All requests succeed
  ✓ Response times acceptable
  ✓ Server stable (no crash)
```

### 4.3 TC-P003: Database Query Performance

```gherkin
Test Case: TC-P003
Category: Performance / Database
Title: DB Query Speed - Get Detections for Date Range

Precondition:
  - 1,000,000 detection events in DB
  - Date range query prepared

Steps:
  1. Query: SELECT * FROM missing_person_detections 
            WHERE timestamp BETWEEN start_date AND end_date
            LIMIT 1000

Expected Result:
  - Query completes in < 50ms
  - Index used (execution plan analyzed)
  - Results accurate

Pass Criteria:
  ✓ Query time < 50ms
  ✓ Indexes present
  ✓ No full table scans
```

---

## 5. Security Test Cases

### 5.1 TC-S001: Authentication Required

```gherkin
Test Case: TC-S001
Category: Security / Access Control
Title: API Requires Authentication

Precondition:
  - API server running
  - No authentication token provided

Steps:
  1. POST /api/missing-persons
     Headers: { "Authorization": "" }
     Body: { valid missing person data }

Expected Result:
  - Status 401 Unauthorized
  - Error: "Missing or invalid token"
  - No data created

Pass Criteria:
  ✓ Request rejected
  ✓ No exception thrown
  ✓ Error message clear
```

### 5.2 TC-S002: Authorization - Admin Only

```gherkin
Test Case: TC-S002
Category: Security / Authorization
Title: Only Admin Can Register Missing Persons

Precondition:
  - User with "Operator" role authenticated

Steps:
  1. POST /api/missing-persons
     Headers: { "Authorization": "Bearer operator_token" }
     Body: { valid missing person data }

Expected Result:
  - Status 403 Forbidden
  - Error: "Insufficient permissions"
  - No data created

Pass Criteria:
  ✓ Request rejected
  ✓ Audit logged
  ✓ Error appropriate
```

### 5.3 TC-S003: Input Validation - SQL Injection

```gherkin
Test Case: TC-S003
Category: Security / Input Validation
Title: Reject SQL Injection Attempts

Precondition:
  - Malicious input prepared

Test Data:
  name: "'; DROP TABLE missing_persons; --"
  description: "<script>alert('xss')</script>"

Steps:
  1. POST /api/missing-persons
     Body: { name, description, ... }

Expected Result:
  - Request rejected or sanitized
  - Malicious content not executed
  - Data stored safely

Pass Criteria:
  ✓ Input sanitized
  ✓ No SQL executed
  ✓ Data integrity maintained
```

---

## 6. Regression Test Cases

### 6.1 TC-R001: Existing Loitering Detection Still Works

```gherkin
Test Case: TC-R001
Category: Regression / Pipeline
Title: Loitering Detection Unaffected by Missing Person Addition

Precondition:
  - Both Loitering Detection and Missing Person Detection active

Steps:
  1. Run existing loitering detection tests
  2. Verify no side effects

Expected Result:
  - All loitering tests pass
  - Latency unchanged
  - Accuracy maintained

Pass Criteria:
  ✓ All loitering tests pass
  ✓ < 5% performance degradation
```

---

## 7. Test Execution Plan

### 7.1 Test Schedule

| Phase | Duration | Tests | Responsible |
|-------|----------|-------|------------|
| Unit Testing | 3 days | TC-U001 ~ U005 | Dev Team |
| Integration Testing | 5 days | TC-I001 ~ I005 | QA Team |
| E2E Testing | 7 days | TC-E001 ~ E003 | QA Team |
| Performance Testing | 3 days | TC-P001 ~ P003 | DevOps |
| Security Testing | 2 days | TC-S001 ~ S003 | Security Team |
| Regression Testing | 2 days | TC-R001 | QA Team |

### 7.2 Test Environment

```
┌─ Test Server (Node.js) ─────────────┐
│ - localhost:3001                    │
│ - Test DB (JSON file)               │
│ - MCP Server enabled                │
│ - Socket.IO mock clients            │
└─────────────────────────────────────┘
```

### 7.3 Pass/Fail Criteria

```
PASS = All test cases pass
     AND performance targets met
     AND no critical bugs

FAIL = Any critical test fails
     OR performance below targets
     OR security vulnerability found
```

---

## 8. Metrics & Reporting

### 8.1 Test Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Unit Test Coverage | > 85% | TBD |
| Integration Coverage | > 80% | TBD |
| E2E Coverage | > 70% | TBD |
| Bug Detection Rate | > 95% | TBD |

### 8.2 Defect Categories

| Severity | Count | Target |
|----------|-------|--------|
| 🔴 Critical | ? | 0 |
| 🟠 High | ? | < 2 |
| 🟡 Medium | ? | < 5 |
| 🟢 Low | ? | < 10 |

---

**TC Document ID**: TC-MP-001  
**Version**: 1.0  
**Status**: READY FOR EXECUTION  
**Last Updated**: 2026-06-01
