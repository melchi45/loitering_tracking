---
name: cross-camera-face-reid
description: "LTS-2026 얼굴 인식 및 크로스 카메라 Re-ID 개발. Use when: 얼굴 등록/검색 기능 구현, 크로스 카메라 동일인 추적, 얼굴 임베딩 벡터 유사도 조정, Face ID 사이드바 UI 수정, 개인정보 보호 마스킹 설정, 얼굴 인식 정확도 개선, 미등록 인물 알림 설정, GDPR 감사 로그 구성. Covers: faceService.js, Design_Face_Recognition, Design_CrossCamera_Face_Tracking, Face ID sidebar component."
argument-hint: "작업 유형 (예: face-registration, reid-threshold, privacy-masking, face-search)"
---

# Cross-Camera Face Re-ID

## 얼굴 인식 파이프라인

```
감지된 person 바운딩 박스
  └─► faceService.js
        ├─► 얼굴 영역 크롭 + 정렬
        ├─► 임베딩 벡터 추출 (512-d)
        ├─► MongoDB face_embeddings 컬렉션과 코사인 유사도 비교
        │     ├─► 일치(threshold 초과) → 등록된 ID 연결
        │     └─► 불일치 → 미등록 인물 임시 ID 부여
        └─► crossCameraTracking → 카메라 간 동선 연결
```

## 핵심 파일 위치

| 파일 | 역할 |
|---|---|
| `server/src/services/faceService.js` | 얼굴 감지·임베딩·검색·등록 전체 로직 |
| `storage/face_tracking.json` | 로컬 얼굴 추적 데이터 (MongoDB 미사용 시) |
| `client/src/components/` | Face ID 사이드바 UI (등록·검색·결과 표시) |
| `server/src/services/mongoDbService.js` | 얼굴 임베딩 벡터 인덱스(Atlas Vector Search) |

## 주요 작업 절차

### 얼굴 등록
```http
POST /api/faces/register
Content-Type: multipart/form-data

{
  "image": <file>,
  "name": "홍길동",
  "personId": "EMP001",
  "metadata": { "department": "보안팀", "accessLevel": "A" }
}
```
1. `faceService.js`에서 임베딩 추출 후 MongoDB에 저장
2. `GET /api/faces/:id` 로 등록 확인
3. 대시보드 Face ID 사이드바에서 즉시 반영 확인

### Re-ID 유사도 임계값 조정
1. `server/src/services/faceService.js` 열기
2. `similarityThreshold` 값 수정 (기본값: `0.6`):
   - 값 낮춤 → 더 관대한 매칭 (오탐 증가 가능)
   - 값 높임 → 더 엄격한 매칭 (미탐 증가 가능)
3. 변경 후 `test/` 얼굴 테스트 케이스로 검증

### 크로스 카메라 동선 조회
```http
GET /api/faces/:personId/tracking?startTime=2026-06-01T00:00:00Z&endTime=2026-06-01T23:59:59Z
```
- MCP 도구: `mcp_lts_get_tracking_history`
- 반환 데이터: 카메라 ID별 출현 시각·좌표 시계열

### 얼굴 검색 (스냅샷 기반)
```http
POST /api/faces/search
Content-Type: multipart/form-data

{ "image": <query_face_image>, "topK": 5 }
```
- 유사도 상위 K명 반환 (등록된 인물 + 임시 ID)

### 개인정보 마스킹 설정
1. `server/src/services/faceService.js`에서 `privacyMode` 옵션 확인
2. `blurFaces: true` 설정 시 미등록 인물 얼굴 블러 처리
3. GDPR 감사 로그: `server/src/services/AuditService.js` 로그 출력 확인

## 임베딩 데이터 구조

```js
// MongoDB face_embeddings 컬렉션 도큐먼트
{
  personId: "EMP001",
  name: "홍길동",
  embedding: [0.12, -0.34, ...],  // 512차원 float 벡터
  sourceCamera: "cam_01",
  capturedAt: ISODate("2026-06-01T10:00:00Z"),
  metadata: { department: "보안팀" }
}
```

## 주의 사항 (개인정보 보호)
- 얼굴 데이터는 GDPR/개인정보보호법 적용 대상
- `AuditService.js`를 통해 모든 얼굴 검색·등록·삭제 기록 유지
- 동의 없는 얼굴 등록 금지 — 시스템 접근 권한 관리 필수
- 데이터 보존 기간 설정: MongoDB TTL 인덱스로 자동 만료

## 관련 설계 문서
- [Design_Face_Recognition.md](../../docs/design/Design_AI_Face_Recognition.md)
- [Design_CrossCamera_Face_Tracking.md](../../docs/design/Design_CrossCamera_Face_Tracking.md)
- [Design_Dashboard_Sidebar_Face_ID.md](../../docs/design/Design_Dashboard_Sidebar_Face_ID.md)
- [Design_Detection_Snapshot_Search.md](../../docs/design/Design_Detection_Snapshot_Search.md)
