# Claude Skill Guide — LTS-2026

> 이 문서는 LTS-2026 프로젝트에서 **Claude AI**의 Skills를 활용하는 방법을 설명합니다.

---

## Skills란?

`.claude/skills/<name>/SKILL.md` 형태로 정의된 온디맨드 워크플로 파일입니다.  
Claude가 관련 작업 요청을 받으면 `description` 키워드를 기반으로 자동 로드하여 프로젝트 맥락에 맞는 응답을 제공합니다.

### 로드 방식

1. **자동 로드** — 요청이 Skill의 `description`에 정의된 키워드와 일치할 때 자동으로 해당 SKILL.md 전문을 컨텍스트에 주입
2. **직접 참조** — 대화에서 스킬 이름을 명시하면 우선 로드

---

## 등록된 Skills 목록

### 1. `ai-detection-pipeline`
**파일**: [skills/ai-detection-pipeline/SKILL.md](skills/ai-detection-pipeline/SKILL.md)

**자동 로드 조건**: YOLOv8 감지 설정, behaviorEngine 배회 점수 조정, attributePipeline 속성 분석, 화재·연기 감지, pipelineManager 서비스 추가, AI 모델 교체, 감지 정확도 디버깅

**예시 요청**:
```
배회 감지 임계값을 45초로 늘리고 싶어
새 차량 감지 모델을 attributePipeline에 추가해줘
detection.js 신뢰도 임계값을 0.4로 낮춰줘
```

---

### 2. `camera-stream-setup`
**파일**: [skills/camera-stream-setup/SKILL.md](skills/camera-stream-setup/SKILL.md)

**자동 로드 조건**: RTSP 카메라 추가/연결, ONVIF 자동 탐색, YouTube/RTMP 스트림 수집, WebRTC·ICE·STUN·TURN 설정, MediaMTX 경로 구성, 스트림 끊김 디버깅

**예시 요청**:
```
RTSP 카메라를 mediamtx에 추가하는 방법 알려줘
WebRTC ICE 연결이 안 돼서 TURN 서버 설정을 봐줘
YouTube 라이브 스트림을 LTS에 연동하고 싶어
```

---

### 3. `zone-alert-management`
**파일**: [skills/zone-alert-management/SKILL.md](skills/zone-alert-management/SKILL.md)

**자동 로드 조건**: 구역 생성·수정·삭제, 배회 임계값·스케줄 설정, 알림 에스컬레이션 정책, acknowledge 처리, 구역 다각형 편집, 알림 UI 수정

**예시 요청**:
```
정문 구역을 야간에만 활성화하도록 스케줄 설정해줘
30분 미확인 알림을 관리자에게 에스컬레이션하도록 해줘
구역 우선순위를 critical로 변경하는 API 예시 보여줘
```

---

### 4. `cross-camera-face-reid`
**파일**: [skills/cross-camera-face-reid/SKILL.md](skills/cross-camera-face-reid/SKILL.md)

**자동 로드 조건**: 얼굴 등록·검색, 크로스 카메라 동일인 추적, 임베딩 유사도 임계값 조정, Face ID UI, 개인정보 마스킹, GDPR 감사 로그

**예시 요청**:
```
얼굴 Re-ID 유사도 임계값을 0.7로 올려줘
GDPR 준수를 위한 얼굴 데이터 보존 기간 설정 방법 알려줘
등록된 얼굴 갤러리에 검색 필터 추가해줘
```

---

### 5. `react-dashboard-dev`
**파일**: [skills/react-dashboard-dev/SKILL.md](skills/react-dashboard-dev/SKILL.md)

**자동 로드 조건**: React 컴포넌트 추가·수정, Zustand 스토어, WebSocket 실시간 훅, Tailwind 스타일링, i18n 다국어, 카메라 그리드·알림 패널·구역 편집기 UI, Vite 빌드 오류

**예시 요청**:
```
카메라 그리드를 6열로 변경해줘
새 알림 유형을 한국어·영어로 i18n 추가해줘
WebSocket으로 실시간 추적 데이터를 받는 커스텀 훅 만들어줘
```

---

### 6. `api-testing`
**파일**: [skills/api-testing/SKILL.md](skills/api-testing/SKILL.md)

**자동 로드 조건**: Jest 테스트 실행, 테스트 케이스 작성, 테스트 오류 디버깅, 커버리지 리포트, GitHub Actions CI 파이프라인

**예시 요청**:
```
얼굴 등록 API 테스트 케이스 작성해줘
WebRTC 관련 테스트만 실행하는 방법 알려줘
테스트 커버리지 80% 이상 달성하도록 누락 테스트 추가해줘
```

---

### 7. `docker-deploy`
**파일**: [skills/docker-deploy/SKILL.md](skills/docker-deploy/SKILL.md)

**자동 로드 조건**: Docker Compose 배포·재빌드·재시작, HTTPS/TLS 인증서, MongoDB 연결, 환경변수 설정, 헬스체크·로그 확인, 포트 충돌

**예시 요청**:
```
프로덕션 환경에 Docker로 배포하는 방법 알려줘
Let's Encrypt TLS 인증서를 서버에 적용해줘
MongoDB Atlas URI를 환경변수로 설정하는 방법 보여줘
```

---

## Skills 파일 구조

```
.claude/
├── CLAUDE.md               — 프로젝트 전체 컨텍스트 (자동 로드)
├── CLAUDE_SKILL_GUIDE.md   — 이 파일 (스킬 활용 가이드)
└── skills/
    ├── ai-detection-pipeline/SKILL.md
    ├── camera-stream-setup/SKILL.md
    ├── zone-alert-management/SKILL.md
    ├── cross-camera-face-reid/SKILL.md
    ├── react-dashboard-dev/SKILL.md
    ├── api-testing/SKILL.md
    └── docker-deploy/SKILL.md
```

---

## 새 Skill 추가 방법

1. `.claude/skills/<skill-name>/SKILL.md` 생성:

```yaml
---
name: skill-name           # 폴더명과 반드시 일치
description: "Use when: ... Covers: ..."
argument-hint: "선택적 힌트"
---

# Skill Title
...
```

2. `.github/skills/<skill-name>/SKILL.md`에도 동일하게 복사 (Copilot 공유):

```bash
cp -r .claude/skills/<skill-name> .github/skills/
```

3. `CLAUDE.md`의 Skills 참조 표에 항목 추가

---

## MCP 도구와 Skills 차이

| 구분 | Skills | MCP 도구 |
|------|--------|----------|
| 목적 | 개발 워크플로 가이드 | 시스템 데이터 실시간 접근 |
| 형태 | 마크다운 절차 문서 | 함수 호출 (`mcp_lts_*`) |
| 예시 | "YOLOv8 모델 교체 방법" | `mcp_lts_get_active_alerts()` |

---

## 관련 파일

- [CLAUDE.md](CLAUDE.md) — 프로젝트 전체 컨텍스트
- [../.github/COPILOT_AGENT_SKILL_GUIDE.md](../.github/COPILOT_AGENT_SKILL_GUIDE.md) — Copilot용 스킬 가이드
- [../mcp-server/SYSTEM_PROMPT.md](../mcp-server/SYSTEM_PROMPT.md) — MCP 서버 시스템 프롬프트
