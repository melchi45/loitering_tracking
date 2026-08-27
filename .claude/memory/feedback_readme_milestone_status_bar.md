---
name: feedback-readme-milestone-status-bar
description: README.md §14 Milestone 표에서 Done vs In Progress/Partial을 가르는 실제 기준 — 미검증(untested)과 미배선(unwired)을 구분할 것
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 21007840-4f9f-4933-a35a-f6132400b623
  modified: 2026-08-27T02:10:03.905Z
---

README.md §14 Project Milestones 표에서 상태(✅ Done / 🟡 In Progress / ⚠️ Partial / 🔲 Planned)를 판단할 때, "잔여 항목이 하나라도 있으면 Done이 아니다"라고 판단하면 안 된다.

**실제 기준 (Phase 11 User Auth 선례로 확인):** Phase 11은 "이메일 인증·2FA(TOTP) 미착수"가 잔여 항목에 명시돼 있는데도 ✅ Done이다. 즉 **핵심 기능이 코드 레벨로 완전히 구현·배선되어 있고, 잔여 항목이 향후 개선/추가 검증 과제일 뿐 설명된 범위 자체의 미완성이 아니라면 Done**이다.

**Done vs In Progress/Partial을 가르는 진짜 질문:** "설명된 기능이 실제로 끝까지 배선되어 동작하는가?"이지, "모든 실사용 시나리오까지 검증됐는가?"가 아니다.
- 🟡/⚠️로 남아야 하는 경우: 기능의 일부가 **아예 연결이 안 돼 있음**(예: 12-B AppearanceReID — Qdrant kNN 조회 자체가 코드에 없어 upsert만 동작), **모델 파일이 배포 안 돼 있어 기본 상태로는 켜도 동작 불가**(12-A Human Parsing), **설명된 Phase 중 일부가 통째로 미착수**(12-C/D의 Phase 2~4).
- ✅ Done이어야 하는 경우: 코드가 설명된 범위를 전부 구현·연결했고, 남은 건 "실제 서드파티 서비스 대상 라이브 E2E 검증"처럼 **테스트/확인이 남았을 뿐 기능 자체는 완결**된 경우 (예: 9-A YouTube PO Token — opt-in 플래그를 켜면 그대로 동작하는 완결된 로직, 남은 건 실 YouTube 채널 대상 검증뿐).

**Why:** 2026-08-27, 9-A(YouTube PO Token 대응)를 "실 라이브 채널 E2E 미검증"이라는 이유만으로 🟡 In Progress로 표기했다가, 사용자가 "이미 구현된 것 아닌가요? 점검이 정상이 아닌 것 같다"고 지적. Phase 11과 비교 검증한 결과 사용자 지적이 맞았음 — 같은 표 안에서 일관되지 않은 기준을 적용한 것이 원인이었다. ✅ Done으로 정정.

**같은 날 두 번째 확인 사례 (12-A vs 12-B/C/D):** 사용자가 12-A~D 4개 행을 한꺼번에 재점검 요청. 코드로 직접 확인한 결과:
- **12-A Human Parsing**: `analyticsConfig.js`의 `humanParsing` 토글 → `attributePipeline.js` → `colorClothService.js#analyze()/_runHumanParsing()`까지 로컬 루프·`/frame` 원격 진입점 양쪽 다 완전 배선되어 있었고, 심지어 `Design_AI_Color_Analysis.md` §10과 `SRS_AI_Color_Analysis.md` FR-CLR-022~027이 **이미 각각 "Implemented"/"✅ Done"으로 정확히 문서화**돼 있었음 — README만 뒤처져 있었다. ✅ Done으로 정정.
- **12-B/12-C/12-D는 그대로 In Progress가 맞았음**: `pipelineManager.js`에 `qdrantService.js#queryAppearance()`(kNN 조회) 호출이 전무함을 grep으로 직접 확인(`upsertAppearance()`만 호출됨) — `Design_AI_AppearanceReID.md` §12.6도 FR-CCFR-064를 "🟡 Partial"로 명시. Age/Gender는 랜드마크 정렬·신뢰도 임계값 코드가 실제로 전무하고, 관련 TC(TC-AGE-018~020 등)가 테스트 파일 헤더에 "Not automated here"로 명시돼 있음을 확인. 즉 이 셋은 설계 문서 자체도 미완성이라고 정확히 말하고 있었다 — README와 설계 문서가 이미 일치.

**교훈:** "구현됐는데 상태가 뒤처진 것 아니냐"는 지적을 받으면, 매번 실제로 코드를 열어 배선 여부를 확인하고 연결된 design/SRS 문서의 Status 필드까지 대조할 것 — 다만 확인 결과 실제로 미완성인 경우도 있으므로(12-B/C/D) 무조건 Done으로 승격하면 안 되고, 매 항목을 독립적으로 검증해야 한다.

**How to apply:** README §14 마일스톤 상태를 판단/검토할 때마다 이 기준으로 재확인할 것 — 특히 opt-in 기능은 "opt-in이라서 기본 비활성"이라는 사실 자체를 미완성의 근거로 쓰지 말 것(QDRANT_ENABLED, humanParsing 토글 등 이 프로젝트의 다른 opt-in 기능들도 opt-in이라는 이유만으로 Done 판정이 막히지 않는다 — 실제 배선 여부가 기준). [[project_youtube_po_token_provider]] 참고.
