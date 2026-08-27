---
name: project-analysis-detections-tab-removal
description: analysis 모드 Dashboard의 마지막 남은 사이드바 탭(Detections/AnalysisEventsTab) 제거 — 2026-07-30
metadata: 
  node_type: memory
  type: project
  originSessionId: b3c8c8ff-973b-46d2-b12c-190f0dae72df
  modified: 2026-07-30T13:24:58.424Z
---

2026-07-30, 같은 날 먼저 완료된 [[project_admin_ai_models_consolidation]] 작업(analytics 탭 제거) 직후,
사용자가 analysis 모드에 마지막까지 남아있던 `detections` 사이드바 탭도 제거 요청 — 이미
`AnalysisServerDashboard`의 "Cumulative Analysis Results → Detections" 카드 클릭 시 동일한 이벤트
히스토리(`AnalysisDetectionPanel`)를 볼 수 있어 완전히 중복이었기 때문.

**변경 내용:**
- `client/src/App.tsx`: `ANALYSIS_TABS`/`AnalysisEventsTab` import 완전 제거, `TAB_ITEMS`의 analysis
  분기를 빈 배열로 변경 → analysis 모드는 사이드바·모바일 하단 nav가 아예 렌더링되지 않고
  `AnalysisServerDashboard`가 데스크톱/모바일 전체 영역을 차지.
- `client/src/components/AnalysisEventsTab.tsx` 파일 자체 삭제 (사용처 0건 확인 후).
- i18n 8개 키(`evt*Short` 등) 15개 로케일 파일에서 제거.
- SDLC 문서 7종(Design/SRS/TC/PRD × Dashboard_Layout + Dashboard_Analysis_Mode) 버전업+개정이력 갱신.
- `.claude/skills/react-dashboard-dev/SKILL.md` + `.github` 미러 동기화(byte-identical 확인),
  `README.md` Mermaid 다이어그램, `CLAUDE.md`/`copilot-instructions.md` 디렉토리 트리의 스테일
  `AnalysisEventsTab.tsx` 항목 제거.

**Why:** 모바일에서 analysis 모드가 이전엔 `AnalysisServerDashboard`를 전혀 렌더링하지 않던
기존 갭이 있었음(탭이 없으면 `renderTabContent()`가 null 반환) — 이번 변경으로 데스크톱과
동일하게 모바일도 `AnalysisServerDashboard`를 보여주도록 함께 고침(스코프 확장이 아니라 필수
동반 수정으로 판단).

**How to apply:** analysis 모드 UI를 다시 다룰 때 이 히스토리를 참고 — analysis 모드는 이제
사이드바/하단 nav가 전혀 없는 것이 의도된 최종 상태이며, "탭이 없어서 이상하다"는 관찰은 버그가
아니라 이 작업의 결과임. `tsc --noEmit` + `npm run build` 클린 확인됨; 커밋/푸시는 미실행
(사용자가 명시적으로 다시 요청할 때까지 보류, [[project_shared_workdir_concurrent_sessions]] 관례).
