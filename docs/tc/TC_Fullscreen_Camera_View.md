# TC: Fullscreen Camera View — 탭 확장 & Detections Timeline

**Version:** 1.3
**Status:** Ready for Test
**SDLC:** [RFP](../rfp/RFP_Fullscreen_Camera_View.md) · [PRD](../prd/PRD_Fullscreen_Camera_View.md) · [SRS](../srs/SRS_Fullscreen_Camera_View.md) · [Design](../design/Design_Fullscreen_Camera_View.md)

---

## 1. 레이아웃 테스트

### TC-01: 데스크톱 우측 DetectionPanel 표시

| 항목 | 내용 |
|------|------|
| 전제 | 브라우저 너비 ≥ 768px |
| 절차 | 1. 대시보드에서 카메라 클릭 → 전체화면 진입 |
| 기대 | 우측에 "DETECTIONS" 패널(288px)이 항상 표시됨 |
| 기대 | 하단 탭 선택과 무관하게 우측 패널 유지 |

### TC-02: 모바일 레이아웃 전환

| 항목 | 내용 |
|------|------|
| 전제 | 브라우저 너비 < 768px |
| 절차 | 1. 전체화면 진입; 2. 브라우저 창 768px 미만으로 축소 |
| 기대 | 레이아웃이 column으로 전환 — 상단 video(60%) + 하단 DetectionPanel(40%) |

### TC-03: 탭 3개 표시

| 절차 | 기대 |
|------|------|
| 전체화면 진입 | 하단에 "Camera Events", "ONVIF Timeline", "Detections" 탭 3개 표시 |
| "Camera Events" 클릭 | 하단 패널 160px, CameraEventsTab 내용 |
| "ONVIF Timeline" 클릭 | 하단 패널 200px, OnvifTimelineInline 내용 |
| "Detections" 클릭 | 하단 패널 300px, DetectionsTimelineInline Gantt 내용 |

---

## 2. Detections Timeline 테스트

### TC-04: 빈 상태 표시

| 절차 | 기대 |
|------|------|
| Detections 탭 진입 | "No detection tracks in this range." 또는 SVG 스피너 표시 |

### TC-05: 트랙 데이터 Gantt 표시

| 전제 | 배회 위험 객체(riskScore≥0.3 또는 isLoitering)가 종료된 내역 있음 |
| 절차 | Detections 탭 → `1H` 범위 선택 |
| 기대 | 수평 Gantt 막대 표시: `[className] [objectId] [dwellTime] [riskScore]` |
| 기대 | 빨간 막대 = isLoitering=true, 초록 막대 = person |

### TC-06: 막대 클릭 상세 패널

| 절차 | 기대 |
|------|------|
| Gantt 막대 클릭 | 우측에 192px 상세 패널 출현 |
| 상세 패널 내용 | Track, First, Last, Dwell, Risk, Loitering, Conf, (Face, Zone, Color) |
| ✕ 버튼 클릭 | 상세 패널 닫힘 |

### TC-07: 줌/팬

| 절차 | 기대 |
|------|------|
| 캔버스에서 스크롤 업 | 줌 인, 막대 확장 |
| 스크롤 다운 | 줌 아웃 |
| 줌 > 1 상태에서 드래그 | 타임라인 패닝 |
| 하단 ◀ ▶ 버튼 | 패닝 |
| ✕ 버튼 | 줌=1, pan=0 리셋 |

### TC-08: 커스텀 날짜 범위

| 절차 | 기대 |
|------|------|
| `Custom` 버튼 클릭 | datetime-local From/To 입력 + Apply 버튼 노출 |
| Apply 클릭 (From/To 미입력) | 버튼 비활성 (disabled) |
| From/To 입력 후 Apply | 해당 범위 데이터 로드 (SVG 스피너 표시 후 결과) |
| ✕ 클릭 | 커스텀 범위 해제, 전체 재조회 |

### TC-09: 클래스 필터

| 절차 | 기대 |
|------|------|
| Class 드롭다운 → "Person" 선택 | person 클래스 트랙만 표시 |
| "All Classes" 선택 | 전체 트랙 표시 |

---

## 3. ONVIF Timeline 커스텀 범위 테스트

### TC-10: Custom 범위 선택

| 절차 | 기대 |
|------|------|
| ONVIF Timeline 탭 → `Custom` 클릭 | datetime-local From/To 입력 행 노출 (보라색 버튼) |
| Apply 전까지 | fetch 없음, 현재 이벤트 목록 유지 |
| Apply 클릭 | 서버에서 해당 범위 이벤트 조회, SVG 스피너 표시 |

### TC-11: ONVIF SVG 스피너

| 절차 | 기대 |
|------|------|
| 범위 변경 또는 Apply 클릭 직후 | 파란색 SVG 스피너 표시 (응답 전까지) |
| 응답 수신 후 | 스피너 사라짐, 이벤트 수 표시 |

---

## 4. 서버 API 테스트

### TC-12: GET /api/analysis/detection-tracks

```bash
# cameraId 필터
curl "http://localhost:3080/api/analysis/detection-tracks?cameraId=CAM01&limit=10"
# 응답: { "tracks": [...], "total": N }

# 날짜 범위 필터
curl "http://localhost:3080/api/analysis/detection-tracks?from=2026-06-16T00:00:00Z&to=2026-06-16T23:59:59Z"

# 클래스 필터
curl "http://localhost:3080/api/analysis/detection-tracks?class=person"
```

| 기대 | `tracks` 배열 (isLoitering=true 또는 riskScore≥0.3인 트랙만) |
| 기대 | `firstSeenAt`, `lastSeenAt`, `dwellTime`, `maxRiskScore`, `isLoitering`, `className` 필드 포함 |

### TC-13: DELETE /api/analysis/detection-tracks

```bash
curl -X DELETE "http://localhost:3080/api/analysis/detection-tracks"
# 응답: { "deleted": N }
```

---

## 5. 트랙 저장 기준 테스트

### TC-14: isLoitering=true 트랙 저장

| 전제 | Zone에 LOITER 감지 설정 활성화, 사람이 임계 시간 이상 체류 |
| 절차 | 카메라 프레임에 isLoitering=true 객체가 나타났다가 사라짐 |
| 기대 | `GET /api/analysis/detection-tracks` 응답에 해당 트랙 포함 |

### TC-15: riskScore < 0.3이고 isLoitering=false 트랙은 저장 안 됨

| 절차 | riskScore=0.1인 person 객체가 나타났다가 사라짐 |
| 기대 | `GET /api/analysis/detection-tracks` 에서 해당 objectId 미포함 |

---

---

## 6. Timeline Name 컬럼 TC

### TC-19: ONVIF Timeline Overlay Name 컬럼 표시 (`OnvifTimelineOverlay` — SearchFullscreen)

| 항목 | 내용 |
|------|------|
| **SRS** | SRS-06-1~4 |
| **전제** | SearchFullscreen 전체화면 ONVIF 오버레이 진입, 이벤트 1건 이상 존재 |
| **절차** | 트랙 목록 최상단 확인 |
| **기대** | "Name" sticky 헤더 행(22px)이 트랙 행들 위에 고정 표시됨 |
| **기대** | 각 트랙 행 좌측 130px에 topicLabel(색상) / sourceToken(gray) / [ruleName](있을 때) 표시 |
| **기대** | 헤더 카메라 뱃지에 cameraId 앞 8자 대신 카메라 표시 이름이 표시됨 (카메라 스토어에 이름 있는 경우) |

### TC-21: ONVIF Timeline Inline Name 컬럼 표시 (`OnvifTimelineInline` — FullscreenCameraView 하단 탭)

| 항목 | 내용 |
|------|------|
| **SRS** | SRS-06-11~16 |
| **전제** | 카메라 전체화면 → 하단 ONVIF Timeline 탭 클릭 → 이벤트 1건 이상 존재 |
| **절차 1** | 트랙 목록 최상단 확인 |
| **기대** | "Name" sticky 헤더 행(22px)이 트랙 행들 위에 고정 표시됨 |
| **기대** | 각 트랙 행 좌측 `LABEL_W=130px`에 topicLabel(severity 색상, bold) 표시 |
| **기대** | sourceToken이 있으면 두 번째 줄에 gray 색상으로 표시됨 |
| **기대** | ruleName이 있으면 세 번째 줄에 `[ruleName]` indigo 색상으로 표시됨 |
| **절차 2** | 스크롤 휠로 줌인 → Gantt 영역 드래그 패닝 |
| **기대** | Name 컬럼(130px)은 고정(flex-shrink-0), Gantt 영역만 좌우 이동됨 |
| **절차 3** | tick 레이블(시간 눈금) 위치 확인 |
| **기대** | tick strip이 Name 컬럼 우측(`left: LABEL_W`)에서 시작하여 Gantt 영역에만 표시됨 |

### TC-20: Detections Timeline Name 컬럼 표시

| 항목 | 내용 |
|------|------|
| **SRS** | SRS-06-5~10 |
| **전제** | 카메라 전체화면 → Detections 탭 진입, 트랙 데이터 1건 이상 존재 |
| **절차 1** | 컨트롤 행 아래 첫 번째 트랙 행 좌측 확인 |
| **기대** | "Name" sticky 헤더 행(20px)이 트랙 행들 위에 표시됨 |
| **기대** | 각 트랙 행 좌측 100px 컬럼에 className(색상, bold) · #objectId_last6(mono·gray) 표시 |
| **기대** | identity가 있는 트랙은 세 번째 줄에 identity 텍스트(indigo) 표시 |
| **절차 2** | 스크롤 휠로 줌인 → Gantt 영역 드래그 |
| **기대** | 패닝 시 Name 컬럼이 고정(flex-shrink-0)되고 Gantt 영역만 이동 |
| **절차 3** | tick 레이블(시간 눈금) 위치 확인 |
| **기대** | tick strip이 Name 컬럼 우측에서 시작하여 Gantt 영역에만 표시됨 (Name 컬럼 아래 tick 없음) |

### TC-22: Detections Timeline Overview strip 접기/펼치기 토글

| 항목 | 내용 |
|------|------|
| **SRS** | SRS-07-3~5 |
| **전제** | 카메라 전체화면 → Detections 탭 진입, 트랙 데이터 1건 이상 존재 |
| **절차 1** | Overview strip(상단 50px 영역) 확인 |
| **기대** | 클래스별 색상 미니 바(8px)가 표시됨; 우측 "All Tracks ▲" 레이블 표시 |
| **절차 2** | Overview strip 클릭 |
| **기대** | 개별 트랙 행(Detail rows)이 사라짐; "All Tracks ▼" 표시; Tick 레이블은 그대로 표시됨 |
| **기대** | Detail panel(우측 스냅샷 뷰어)도 함께 닫힘 |
| **절차 3** | Overview strip 재클릭 |
| **기대** | 트랙 행 복원; "All Tracks ▲" 복귀 |
| **절차 4** | Overview strip에서 스크롤 휠 동작 |
| **기대** | 줌 인/아웃 동작; Detail rows 영역 스크롤 휠은 수직 스크롤만 작동 |

### TC-23: ONVIF Timeline Inline Overview strip 접기/펼치기 토글

| 항목 | 내용 |
|------|------|
| **SRS** | SRS-07-7~9 |
| **전제** | 카메라 전체화면 → ONVIF Timeline 탭 진입, ONVIF 이벤트 1건 이상 존재 |
| **절차 1** | Overview strip(상단 50px) 확인 |
| **기대** | 모든 이벤트 타입 오버레이 표시 — duration 이벤트는 8px 미니 바, point 이벤트는 2px 수직 바로 표시됨; "All Events ▲" 레이블 |
| **절차 2** | Overview strip 클릭 |
| **기대** | 개별 이벤트 행 사라짐; Tick 레이블 유지; "All Events ▼" 표시 |
| **절차 3** | 재클릭 |
| **기대** | 이벤트 행 복원 |
| **절차 4** | Overview 스크롤 휠 |
| **기대** | 타임라인 줌 인/아웃; Detail rows 스크롤은 수직 전용 |

---

## ONVIF Timeline 범위 프리셋 TC

> 이 섹션의 TC는 `SERVER_MODE=streaming`에서만 실행됩니다 (`streamingOnly`).
> 자동화 스크립트: `test/api/timeline_range.test.js`

### TC-16: ONVIF Timeline 기본 범위가 1H임을 확인

| 항목 | 내용 |
|------|------|
| **SRS** | SRS-04-1 (기본값 `1H`) |
| **절차** | ONVIF Timeline 탭 진입 → 컨트롤 행에서 활성 버튼 확인 |
| **기대** | `[1H]` 버튼이 활성(강조) 상태; 타임라인이 현재 시각 기준 1시간 범위 표시 |

### TC-17: 1H 범위 선택 시 올바른 from 파라미터 전송

| 항목 | 내용 |
|------|------|
| **SRS** | SRS-04-1, FR-ONVIF-RANGE-001 |
| **조건** | `streamingOnly` — `test/api/timeline_range.test.js TC-TIMELINE-RANGE-001` 참조 |
| **절차** | `GET /api/onvif-events?from=<now-1H>&limit=1000` 호출 |
| **기대** | HTTP 200; 반환된 모든 이벤트 `serverTs ≥ from` |

### TC-18: 6H 범위 버튼 선택

| 항목 | 내용 |
|------|------|
| **SRS** | SRS-04-1, FR-ONVIF-RANGE-002 |
| **조건** | `streamingOnly` — `test/api/timeline_range.test.js TC-TIMELINE-RANGE-008` 참조 |
| **절차** | ONVIF Timeline 탭에서 `[6H]` 버튼 클릭 → API 호출 관찰 |
| **기대** | `GET /api/onvif-events?from=<now-6H>` 호출; 반환 이벤트 모두 `[from, now]` 구간 내 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — Fullscreen Camera View 탭 확장 + Detections Timeline TC |
| 1.1 | 2026-06-24 | TC-16~18 추가 — ONVIF Timeline 1H/6H 범위 프리셋 및 기본값 1H 검증 (streamingOnly) |
| 1.2 | 2026-06-26 | TC-19~20 추가 — ONVIF·Detections Timeline Name 컬럼 표시 검증 |
| 1.3 | 2026-06-26 | TC-19 제목 수정(Overlay 명시), TC-21 추가 — `OnvifTimelineInline`(FullscreenCameraView 하단 탭) Name 컬럼 세부 검증 (SRS-06-11~16) |
| 1.4 | 2026-06-26 | TC-22~23 추가 — Detections/ONVIF Timeline Overview strip 접기/펼치기 토글 + scroll isolation 검증 (SRS-07-3~5, SRS-07-7~9) |
