# PRD_AI_Missing_Person_Detection.md

## Product Requirements Document: AI Missing Person Detection

**문서 버전**: 1.0  
**작성일**: 2026-06-01  
**상태**: APPROVED  
**담당자**: AI Team  

---

## 1. Executive Summary

**LTS-2026** AI 배회 감지 시스템에 **실종자 감지(Missing Person Detection)** 기능을 추가합니다.

이를 통해:
- ✅ 실종자 정보 등록 및 관리
- ✅ 실시간 얼굴 매칭 (98% 정확도 목표)
- ✅ 카메라 네트워크 전체에서 자동 감지
- ✅ 실시간 알림 및 추적
- ✅ LLM(Claude)을 통한 자연어 쿼리 지원

---

## 2. Problem Statement

### 2.1 현재 상황 (Current State)

실종자 수색은 수동 검색에 의존:
- 경찰청 협력 필요
- 시간 지연 (수 시간 ~ 수 일)
- 전국 CCTV 네트워크 조회 비효율

### 2.2 문제점 (Pain Points)

| 문제 | 영향 | 우선순위 |
|------|------|---------|
| 수동 검색 | 황금 시간 손실 | 🔴 HIGH |
| 스케일 한계 | 많은 카메라 → 낮은 커버리지 | 🟠 MEDIUM |
| 오경보 없음 | 잘못된 감지 관리 불가 | 🟠 MEDIUM |
| 데이터 분산 | 여러 시스템 통합 필요 | 🟡 LOW |

---

## 3. Solution Overview

### 3.1 핵심 기능 (Core Features)

#### 3.1.1 실종자 등록 (Missing Person Registry)

```
Admin Portal
    ↓
사진 업로드 + 정보 입력
    ↓
얼굴 임베딩 생성 (FaceNet)
    ↓
DB 저장 + 캐시 로드
```

**필수 정보**:
- 이름, 나이, 성별
- 신체 특징 (키, 의류, 액세서리)
- 얼굴 사진 (정면, 고품질)
- 비상 연락처

#### 3.1.2 실시간 감지 (Real-time Detection)

```
RTSP 스트림 (10 FPS)
    ↓
YOLO 객체 감지
    ↓
얼굴 추출 (Face Detection)
    ↓
임베딩 생성 (FaceNet)
    ↓
실종자 DB와 비교 (Cosine Similarity)
    ↓
유사도 >= 0.75?
    ├─ YES → Detection Event 생성 → Alert
    └─ NO → 무시
```

#### 3.1.3 크로스 카메라 추적 (Cross-Camera Tracking)

- 동일 인물의 카메라 간 이동 경로 추적
- 예측 기반 다음 카메라 추정
- 위치 정보 시각화

#### 3.1.4 자연어 쿼리 (LLM Integration)

```
User: "오늘 김철수를 감지했나?"

LLM → MCP Call:
- searchMissingPerson('김철수')
- getMissingPersonDetections(today)

Response:
"네, 오늘 3회 감지되었습니다.
 - 14:25 카메라 1 (유사도 92%)
 - 15:10 카메라 3 (유사도 88%)
 - 16:45 카메라 5 (유사도 95%)"
```

---

## 4. Requirements Breakdown

### 4.1 Functional Requirements (FR)

| ID | 요구사항 | 우선순위 | 상태 |
|----|---------|---------|------|
| FR-001 | 실종자 정보 등록 | MUST | TODO |
| FR-002 | 실종자 정보 수정/삭제 | MUST | TODO |
| FR-003 | 실시간 얼굴 매칭 | MUST | TODO |
| FR-004 | Detection Event 저장 | MUST | TODO |
| FR-005 | Alert 생성 및 전송 | MUST | TODO |
| FR-006 | 크로스 카메라 추적 | SHOULD | TODO |
| FR-007 | 수동 확인/거부 UI | SHOULD | TODO |
| FR-008 | 통계 리포트 | COULD | TODO |
| FR-009 | MCP Tool 제공 | MUST | TODO |
| FR-010 | LLM 자연어 쿼리 | MUST | TODO |

### 4.2 Non-Functional Requirements (NFR)

| 타입 | 요구사항 | 목표값 |
|------|---------|--------|
| **성능** | 감지 지연 | < 500ms |
| **성능** | 매칭 처리량 | 100 face/sec |
| **정확도** | 유사도 임계값 | 0.75 (92% 신뢰도) |
| **정확도** | False Positive Rate | < 5% |
| **가용성** | 시스템 가용도 | 99.5% |
| **확장성** | 동시 실종자 DB | 10,000 persons |
| **보안** | 접근 제어 | Admin 전용 |
| **보안** | 데이터 암호화 | AES-256 |

---

## 5. User Stories

### 5.1 Admin - 실종자 등록

```gherkin
Feature: 실종자 등록
  As an Admin
  I want to register a missing person
  So that the system can detect them across cameras

  Scenario: 성공적인 실종자 등록
    Given 관리자 로그인
    When 사진 업로드 + 정보 입력
    Then 시스템은 얼굴 임베딩 생성
    And 실종자 DB에 저장
    And "등록 완료" 메시지 표시
```

### 5.2 Operator - 감지 모니터링

```gherkin
Feature: 감지 모니터링
  As an Operator
  I want to see real-time missing person detections
  So that I can take immediate action

  Scenario: 실종자 감지 알림
    Given 카메라에서 프레임 수신
    When 등록된 실종자와 얼굴 매칭
    And 유사도 >= 0.75
    Then 대시보드에 빨간 경고 표시
    And Socket.IO 이벤트 발송
    And SMS/Push 알림 전송
```

### 5.3 LLM/Claude - 자연어 쿼리

```gherkin
Feature: 실종자 검색 쿼리
  As an LLM
  I want to query missing person data via MCP
  So that I can respond to natural language questions

  Scenario: "오늘 김철수를 봤나?"
    Given MCP Tool 호출
    When searchMissingPerson('김철수') + getTodayDetections()
    Then 감지 목록 반환
    And LLM이 답변 생성
```

---

## 6. Use Cases

### Use Case 1: 실종자 실시간 감지

```
Actor: Monitoring System
Precondition: 실종자가 DB에 등록됨

Main Flow:
1. 카메라에서 프레임 수신
2. YOLO로 객체 감지
3. 얼굴 추출 & 임베딩 생성
4. 실종자 DB와 비교
5. 유사도 0.92 (임계값 0.75 초과)
6. Detection Event 생성
7. Alert 발생
8. Operator 대시보드에 표시
9. 경찰 연락처에 자동 전송 (설정 시)

Postcondition: 실종자 위치 기록 및 추적
```

### Use Case 2: LLM 자연어 질의

```
Actor: User (via LLM/Claude)
Question: "어제 서울에서 47세 여성을 봤나?"

Flow:
1. LLM이 자연어 파싱
2. MCP Call: searchMissingPerson({ age: 47, gender: 'F', location: 'Seoul' })
3. 매칭되는 실종자 반환: ID 3개
4. 각 ID별로 getMissingPersonDetections(yesterday) 호출
5. 감지 이벤트 반환
6. LLM이 자연어 답변 생성

Response:
"네, 47세 여성 '박영희'가 어제 5회 감지되었습니다.
 - 08:30 서울역 근처
 - 10:15 강남역 근처
 ..."
```

---

## 7. Scope & Out of Scope

### 7.1 In Scope ✅

- 실종자 정보 등록/관리
- 실시간 얼굴 매칭
- Detection Event 저장 & 분석
- Alert 생성 및 Socket.IO 전송
- MCP Tool 제공
- 기본 통계 리포트
- 문서 & 테스트

### 7.2 Out of Scope ❌

- 모바일 앱 (별도 프로젝트)
- 수동 CCTV 재검색 기능
- 경찰청 시스템 연동 (향후)
- 음성 신고 접수 시스템
- 블록체인 증명 (향후)

---

## 8. Success Criteria

| 메트릭 | 목표 | 측정 방법 |
|--------|------|---------|
| Detection Accuracy | 92% 이상 | 테스트 세트 평가 |
| False Positive Rate | < 5% | 실제 운영 데이터 |
| 감지 지연 | < 500ms | 성능 테스트 |
| 시스템 가용도 | 99.5% 이상 | 모니터링 대시보드 |
| 사용자 만족도 | 4.5/5.0 이상 | 설문조사 |

---

## 9. Timeline

| Phase | Timeline | Deliverables |
|-------|----------|--------------|
| Design | 06.01 | Design Doc + PRD + SRS |
| Implementation | 06.02 ~ 06.15 | Code + Unit Tests |
| Integration Testing | 06.16 ~ 06.22 | Integration Tests + Bug Fixes |
| E2E Testing | 06.23 ~ 06.30 | E2E Tests + Performance Tuning |
| Deployment | 07.01 ~ 07.07 | Production Deployment |
| Monitoring | 07.08+ | Monitoring & Support |

---

## 10. Risks & Mitigation

| 리스크 | 영향 | 확률 | 완화 전략 |
|--------|------|------|---------|
| 얼굴 임베딩 정확도 부족 | 높음 | 중간 | FaceNet 모델 재학습 |
| 스케일링 이슈 | 높음 | 낮음 | Redis 캐싱 + 배치 처리 |
| 개인정보 유출 | 매우높음 | 낮음 | 암호화 + 접근제어 + 감사 |
| 규제 변경 | 중간 | 중간 | 법무팀 검토 + 컴플라이언스 |

---

## 11. Assumptions

1. 실종자 사진 품질이 충분히 높음
2. YOLO 얼굴 감지 정확도 > 90%
3. FaceNet 임베딩 모델은 안정적임
4. 카메라 네트워크가 안정적으로 운영 중
5. 법적, 규제적 승인 확보됨

---

## 12. Dependencies

- **FaceNet Model**: 사전 학습된 512D 임베딩 모델
- **YOLO**: 객체 감지 모델
- **ByteTrack**: 다중 객체 추적
- **MongoDB** 또는 **JSON File DB**: 데이터 저장
- **Socket.IO**: 실시간 통신
- **MCP Server**: LLM 통합

---

## 13. Approval

| 역할 | 이름 | 서명 | 날짜 |
|------|------|------|------|
| Product Manager | [PM] | ✓ | 2026-06-01 |
| Tech Lead | [Lead] | ✓ | 2026-06-01 |
| Security Officer | [SecOps] | ✓ | 2026-06-01 |
| Legal/Compliance | [Compliance] | ✓ | 2026-06-01 |

---

**문서 ID**: PRD-MP-001  
**최종 수정**: 2026-06-01  
**상태**: ✅ APPROVED FOR IMPLEMENTATION
