# Design_AI_Missing_Person_Detection.md

## 개요 (Overview)

**LTS-2026** 시스템에 **실종자 감지(Missing Person Detection)** 기능을 추가하여 
카메라 네트워크에서 등록된 실종자의 얼굴을 자동 감지하고, 감지 시 실시간 알림을 발생시킵니다.

---

## 1. 아키텍처 (Architecture)

### 1.1 데이터 흐름

```
실종자 DB (Missing Person Registry)
    ↓
얼굴 임베딩 비교 (Face Embedding Comparison)
    ↓
ByteTrack 추적 (Cross-Camera Re-ID)
    ↓
경보 생성 (Alert Generation)
    ↓
실시간 알림 (Real-time Notification)
```

### 1.2 주요 컴포넌트

#### A. **MissingPersonService** (`server/src/services/missingPersonService.js`)
- 실종자 데이터베이스 관리
- 얼굴 임베딩 매칭 (similarity score 계산)
- 카메라별 실종자 감지 통계

#### B. **Face Re-ID Integration**
- 기존 `faceService.js` 활용
- 실시간 프레임에서 추출한 얼굴 임베딩과 실종자 임베딩 비교
- 유사도 임계값: `0.75` (90% 유사도 이상)

#### C. **MCP Tool Layer** (`mcp-server/tools/missing-person.js`)
- `searchMissingPerson(query)` - 이름, 나이, 특징으로 검색
- `registerMissingPerson(data)` - 실종자 정보 + 얼굴 사진 등록
- `getMissingPersonDetections(date)` - 오늘의 감지 결과
- `updateMissingPersonStatus(id, status)` - 실종자 상태 변경 (찾음/확인불가)

#### D. **Pipeline Integration**
- `pipelineManager.js`에 Missing Person 감지 단계 추가
- 배회 감지(loitering) 직후 Missing Person 매칭 실행
- 병렬 처리 최적화

---

## 2. 데이터 모델 (Data Model)

### 2.1 Missing Person 스키마

```javascript
{
  id: "UUID",                          // 고유 ID
  name: "김철수",                       // 실종자 이름
  age: 45,                             // 나이
  gender: "M",                         // 성별 (M/F)
  description: "180cm, 검은색 옷",      // 신체 특징
  photoUrl: "s3://bucket/...",        // 얼굴 사진 URL
  faceEmbedding: [0.123, ...],        // 512차원 임베딩 벡터
  reportedDate: "2026-06-01T10:30:00Z", // 신고 날짜
  status: "MISSING",                   // 상태: MISSING/FOUND/UNCONFIRMED
  priority: "HIGH",                    // 우선순위: LOW/MEDIUM/HIGH
  contacts: {
    name: "이순신",
    phone: "010-1234-5678",
    relation: "아들"
  },
  metadata: {
    createdBy: "admin@example.com",
    createdAt: "2026-06-01T10:30:00Z",
    updatedAt: "2026-06-01T10:30:00Z"
  }
}
```

### 2.2 Missing Person Detection Event 스키마

```javascript
{
  id: "UUID",
  missingPersonId: "UUID",             // 실종자 ID
  cameraId: "UUID",                    // 감지된 카메라
  timestamp: "2026-06-01T14:25:00Z",   // 감지 시간
  similarity: 0.92,                    // 유사도 (0~1)
  frameId: 6081,                       // 프레임 ID
  boundingBox: {                       // 감지 영역
    x: 100,
    y: 50,
    width: 80,
    height: 120
  },
  trackingId: "track-001",             // 추적 ID (ByteTrack)
  status: "CONFIRMED",                 // PENDING/CONFIRMED/FALSE_POSITIVE
  metadata: {
    alertSent: true,
    alertedAt: "2026-06-01T14:25:05Z"
  }
}
```

---

## 3. 알고리즘 (Algorithm)

### 3.1 얼굴 매칭 알고리즘

```
For each detected person in frame:
  1. Extract face embedding (FaceNet 512D vector)
  2. For each missing person in registry:
     a. Calculate cosine similarity with stored embedding
     b. If similarity >= THRESHOLD (0.75):
        - Create detection event
        - Calculate confidence score
        - Trigger alert
  3. Update cross-camera tracking metadata
```

### 3.2 유사도 계산

```
similarity = (embedding1 · embedding2) / (||embedding1|| × ||embedding2||)

Confidence Score = 
  0.5 × similarity +
  0.3 × timeDecay +        // 최근 감지 가중치
  0.2 × locationRelevance  // 지역 관련성
```

### 3.3 오경보 제거 (False Positive Reduction)

- 단일 프레임 감지 → 30초 내 재감지 확인 필요
- 임계값을 넘는 연속 감지 → 자동 CONFIRMED
- 수동 조정 UI 제공

---

## 4. 통합 지점 (Integration Points)

### 4.1 PipelineManager 수정

```javascript
// server/src/services/pipelineManager.js
async processFrame(frame) {
  // 1. YOLO 감지
  const detections = await detectionService.detect(frame);
  
  // 2. ByteTrack 추적
  const tracked = await trackingService.update(detections);
  
  // 3. 배회 분석
  const loiteringEvents = await behaviorEngine.analyze(tracked);
  
  // 4. ✨ Missing Person 감지 (신규)
  const missingPersonEvents = await missingPersonService.matchFaces(frame, tracked);
  
  // 5. 경보 생성
  await alertService.generate([...loiteringEvents, ...missingPersonEvents]);
}
```

### 4.2 Socket.IO 이벤트

```javascript
// 실종자 감지 이벤트
io.emit('missingPersonDetected', {
  missingPersonId: 'mp-001',
  name: '김철수',
  similarity: 0.92,
  cameraId: 'cam-001',
  timestamp: Date.now(),
  boundingBox: { x, y, width, height },
  priority: 'HIGH'
});
```

---

## 5. MCP Server Integration

### 5.1 새로운 MCP Tools

```javascript
// mcp-server/tools/missing-person.js

/**
 * 실종자 등록
 */
registerMissingPerson({
  name, age, gender, description,
  photoUrl,  // base64 or URL
  contacts: { name, phone, relation }
})

/**
 * 실종자 검색
 */
searchMissingPerson({
  query,     // 이름, 나이, 특징
  limit: 10
})

/**
 * 오늘의 감지 결과
 */
getMissingPersonDetections({
  date: '2026-06-01',
  status: 'CONFIRMED',
  limit: 50
})

/**
 * 상태 업데이트
 */
updateMissingPersonStatus({
  missingPersonId: 'mp-001',
  status: 'FOUND'  // FOUND, UNCONFIRMED, FALSE_POSITIVE
})

/**
 * 감지 이벤트 상세 조회
 */
getDetectionDetails({
  detectionId: 'det-001'
})
```

### 5.2 LLM Prompt Integration

```
LLM Query: "오늘 실종자 '김철수'를 감지했나?"

MCP Call Chain:
1. searchMissingPerson({ query: '김철수' })
   → missingPersonId = 'mp-001'

2. getMissingPersonDetections({ 
     date: today,
     missingPersonId: 'mp-001'
   })
   → [detection events]

3. Format response with locations, times, confidence
```

---

## 6. DB 저장 구조 (Storage)

### 6.1 `storage/lts.json` 확장

```json
{
  "missing_persons": [
    { ... missing person object ... }
  ],
  "missing_person_detections": [
    { ... detection event object ... }
  ],
  "missing_person_stats": {
    "total_registered": 5,
    "total_detections_today": 12,
    "confirmed_detections": 8,
    "false_positives": 2,
    "by_priority": {
      "HIGH": 3,
      "MEDIUM": 4,
      "LOW": 1
    }
  }
}
```

### 6.2 MongoDB Collection (Optional)

```javascript
db.missingPersons.find()
db.missingPersonDetections.aggregate([
  { $match: { status: 'CONFIRMED' } },
  { $sort: { timestamp: -1 } }
])
```

---

## 7. 성능 최적화 (Performance)

### 7.1 임베딩 캐싱

- 실종자 임베딩 메모리 캐시 (서버 시작 시 로드)
- 캐시 갱신 이벤트 (새 실종자 등록 시)

### 7.2 배치 처리

- 프레임 당 최대 5개 얼굴만 비교
- 우선순위 기반 정렬 (HIGH → MEDIUM → LOW)

### 7.3 네트워크 최적화

- 감지 이벤트 배치 전송 (100ms 간격)
- WebRTC 트래픽과 분리된 Socket.IO 채널

---

## 8. 보안 고려사항 (Security)

- 실종자 사진 암호화 저장
- 접근 제어: Admin 전용 등록/수정
- 감지 이벤트 감사 로그
- 개인정보 보호 규정 준수 (GDPR, 개인정보보호법)

---

## 9. 테스트 전략 (Testing)

### 9.1 Unit Tests
- Face matching accuracy: 임베딩 유사도 계산
- DB CRUD operations

### 9.2 Integration Tests
- Pipeline integration: YOLO → ByteTrack → Missing Person
- MCP tool correctness

### 9.3 E2E Tests
- End-to-end missing person detection workflow
- Real camera input simulation
- Alert generation verification

---

## 10. 확장 계획 (Future Enhancements)

- Multi-camera trajectory prediction
- Deep learning based age/gender estimation for refinement
- Mobile app push notifications
- Social media integration (자동 공유)
- 블록체인 기반 증명 기록 (proof of detection)

---

**설계 완료**: 2026-06-01
**작성자**: GitHub Copilot
