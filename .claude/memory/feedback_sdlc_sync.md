---
name: feedback-sdlc-sync
description: SDLC 문서-코드 동기화 — 코드 변경 시 반드시 같은 응답에서 docs/skills 업데이트
metadata: 
  node_type: memory
  type: feedback
  originSessionId: efe7e88e-e0aa-4d16-9a96-bc57f5c4d1d5
---

코드를 변경할 때 docs/skills 업데이트를 나중으로 미루지 말고 **같은 응답 내에서 즉시** 수행해야 한다.

**Why:** 사용자가 코드 변경이 있었음에도 docs/skills가 업데이트되지 않은 것을 발견하고 직접 지적함. CLAUDE.md에 명시된 SDLC 동기화 규칙임에도 "나중에 정리"로 미룬 것은 규칙 위반.

**How to apply:**
- 코드 수정 응답마다: 변경된 코드 유형에 해당하는 문서(docs/design/, docs/srs/)와 스킬(.claude/skills/, .github/skills/)을 같은 응답에서 업데이트
- `.claude/skills/`와 `.github/skills/`는 항상 동일해야 하므로 cp 또는 동일 Edit으로 동기화
- 빌드가 필요한 클라이언트 변경(App.tsx 등)은 코드 수정 후 `cd client && npm run build`까지 같은 응답에서 실행
- 여러 코드 변경이 연속될 때도 각각의 변경마다 즉시 문서 업데이트 — 묶어서 처리하지 않음
