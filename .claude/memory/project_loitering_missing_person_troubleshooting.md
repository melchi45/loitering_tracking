---
name: project-loitering-missing-person-troubleshooting
description: "Loitering/missing-person 감지가 \"동작 안 함\" 보고 시 확인할 3가지 전제조건과 진단 방법"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2f83e181-0882-4f7f-b4b6-0e571cd3cfe5
---

2026-07-08 기준, 배회 감지·실종자 감지가 "동작하지 않는다"는 보고는 코드 버그가 아니라 아래 3가지 전제조건 누락이 원인이었다.

1. **구역(Zone) 미설정** — `behaviorEngine.js`는 카메라에 등록된 MONITOR 구역이 있어야 dwell time을 계산해 배회를 판정한다 (`zoneManager.getActiveZones`). 구역이 0개면 `loiteringTotal`은 프레임을 아무리 처리해도 항상 0.
2. **`face` analytics config 비활성** — `/api/analytics/config`의 `face`가 false면 얼굴 임베딩 추출 파이프라인 자체가 꺼져 있어 실종자 얼굴 매칭이 불가능. streaming 모드에서는 PUT 시 자동으로 analysis 서버에도 forward됨 (`server/src/api/analytics.js`의 `_forwardToAnalysis`).
3. **실종자 등록부(missing_persons)가 비어있음** — `/api/missing-persons`가 빈 배열이면 매칭 대상 자체가 없음.

**Why:** 세 조건이 모두 독립적으로 충족되어야 파이프라인이 end-to-end로 동작하며, 세 가지 다 코드가 아닌 런타임 설정/데이터 상태라서 로그에 에러가 남지 않는다 (조용히 0건만 쌓임).

**How to apply:** 유사 보고를 받으면 먼저 `GET /api/analysis/metrics` (analysis 서버)에서 카메라별 `zoneCount`와 `loiteringTotal`/`facesTotal` 누적치를 확인하고, `GET /api/analytics/config`의 `face` 값, `GET /api/missing-persons`의 `total`을 확인한다. streaming↔analysis 연결 상태는 `GET /api/analysis/client-status` (`circuitOpen`, `errors`)로 별도 확인.

테스트 등록 시 `registerMissingPerson`은 `faceEmbedding`을 안 주면 `_seededEmbedding`으로 이름 기반 의사난수 벡터를 생성한다 — 실제 사진 기반 매칭 검증에는 쓸 수 없고 파이프라인 동작(등록 성공, embeddingCache 반영) 확인용으로만 유효하다.
