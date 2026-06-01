# GitHub Copilot Agent Skill Guide — LTS-2026

> 이 문서는 LTS-2026 프로젝트에서 GitHub Copilot Agent의 **Skills**를 활용하는 방법을 설명합니다.

---

## Skills란?

**Skills**는 특정 작업 영역의 지식과 절차를 캡슐화한 온디맨드 워크플로 파일입니다.  
Copilot Agent가 관련 작업 요청을 받으면 자동으로 해당 Skill을 로드하여 더 정확하고 맥락에 맞는 응답을 제공합니다.

### 호출 방법

1. **자동 호출** — 요청 내용이 Skill의 `description`에 정의된 키워드와 일치하면 자동 로드
2. **슬래시 명령** — VS Code Copilot Chat에서 `/` 입력 후 스킬 이름 선택

---

## 등록된 Skills 목록

### 1. `ai-detection-pipeline`
**파일**: [.github/skills/ai-detection-pipeline/SKILL.md](.github/skills/ai-detection-pipeline/SKILL.md)

**자동 호출 조건**:
- YOLOv8 감지 모델 설정·교체
- 배회 점수(riskScore) 임계값 조정
- 의상·색상·마스크·헬멧 속성 분석 기능 수정
- 화재·연기 감지(`fireSmokeService.js`) 작업
- `pipelineManager.js`에 새 AI 서비스 추가
- AI 감지 정확도 개선 또는 성능 디버깅

**예시 프롬프트**:
```
배회 감지 임계값을 45초로 늘리고 싶어
새로운 차량 감지 모델을 attributePipeline에 추가해줘
detection.js의 신뢰도 임계값을 0.4로 낮춰줘
```

---

### 2. `camera-stream-setup`
**파일**: [.github/skills/camera-stream-setup/SKILL.md](.github/skills/camera-stream-setup/SKILL.md)

**자동 호출 조건**:
- RTSP 카메라 추가 또는 연결 문제 해결
- ONVIF 카메라 자동 탐색
- YouTube/RTMP 스트림 수집 설정
- WebRTC 연결·ICE/STUN/TURN 설정
- MediaMTX 프록시 경로 구성
- 카메라 스트림 끊김 디버깅

**예시 프롬프트**:
```
RTSP 카메라를 mediamtx에 추가하는 방법 알려줘
WebRTC ICE 연결이 안 돼서 TURN 서버 설정을 봐줘
YouTube 라이브 스트림을 LTS에 연동하고 싶어
```

---

### 3. `zone-alert-management`
**파일**: [.github/skills/zone-alert-management/SKILL.md](.github/skills/zone-alert-management/SKILL.md)

**자동 호출 조건**:
- 보안 구역(Zone) 생성·수정·삭제
- 구역별 배회 임계값 및 스케줄 설정
- 알림 에스컬레이션 정책 구성
- 알림 acknowledge 처리 로직
- 대시보드 구역·알림 사이드바 UI 수정

**예시 프롬프트**:
```
정문 구역을 야간에만 활성화하도록 스케줄 설정해줘
30분 이상 확인 안 된 알림은 관리자에게 에스컬레이션되도록 해줘
구역 우선순위를 critical로 올리는 API 예시 보여줘
```

---

### 4. `cross-camera-face-reid`
**파일**: [.github/skills/cross-camera-face-reid/SKILL.md](.github/skills/cross-camera-face-reid/SKILL.md)

**자동 호출 조건**:
- 얼굴 등록 또는 검색 기능 구현
- 크로스 카메라 동일인 추적
- 얼굴 임베딩 유사도 임계값 조정
- Face ID 사이드바 UI 수정
- 개인정보 보호 마스킹·GDPR 감사 로그 설정

**예시 프롬프트**:
```
얼굴 Re-ID 유사도 임계값을 0.7로 올려줘
등록된 얼굴 갤러리 UI에 검색 필터 추가해줘
GDPR 준수를 위한 얼굴 데이터 보존 기간 설정 방법 알려줘
```

---

### 5. `react-dashboard-dev`
**파일**: [.github/skills/react-dashboard-dev/SKILL.md](.github/skills/react-dashboard-dev/SKILL.md)

**자동 호출 조건**:
- React 대시보드 컴포넌트 추가·수정
- Zustand 스토어 상태 관리
- Socket.IO/WebSocket 실시간 이벤트 훅
- Tailwind CSS 스타일링
- i18n 다국어 텍스트 추가
- 카메라 그리드·알림 패널·구역 편집기 UI
- Vite 빌드 오류 수정

**예시 프롬프트**:
```
카메라 그리드를 6열로 변경해줘
새 알림 유형을 한국어·영어로 i18n 추가해줘
WebSocket으로 실시간 추적 데이터를 받는 커스텀 훅 만들어줘
```

---

### 6. `api-testing`
**파일**: [.github/skills/api-testing/SKILL.md](.github/skills/api-testing/SKILL.md)

**자동 호출 조건**:
- Jest 단위·통합·E2E 테스트 실행
- 새 기능에 대한 테스트 케이스 작성
- 테스트 오류 디버깅
- 테스트 커버리지 리포트 생성
- GitHub Actions CI 파이프라인 수정

**예시 프롬프트**:
```
얼굴 등록 API 테스트 케이스 작성해줘
WebRTC 관련 테스트만 실행하는 방법 알려줘
테스트 커버리지 80% 이상 되도록 누락된 테스트 추가해줘
```

---

### 7. `docker-deploy`
**파일**: [.github/skills/docker-deploy/SKILL.md](.github/skills/docker-deploy/SKILL.md)

**자동 호출 조건**:
- Docker Compose 전체 스택 배포
- 컨테이너 재빌드 및 서비스 재시작
- HTTPS/TLS 인증서 설정
- MongoDB Atlas 연결 설정
- 환경변수(`.env`) 구성
- 서비스 헬스체크·로그 확인

**예시 프롬프트**:
```
프로덕션 환경에 Docker로 배포하는 방법 알려줘
Let's Encrypt TLS 인증서를 서버에 적용해줘
MongoDB Atlas URI를 환경변수로 설정하는 방법 보여줘
```

---

## Skills 파일 위치

| 경로 | 사용 대상 |
|------|----------|
| `.github/skills/<name>/SKILL.md` | GitHub Copilot Agent |
| `.claude/skills/<name>/SKILL.md` | Claude (Anthropic) |

두 디렉토리는 동일한 내용을 공유합니다. Skill 내용 수정 시 양쪽 모두 업데이트하세요.

---

## 새 Skill 추가 방법

1. `.github/skills/<skill-name>/` 디렉토리 생성
2. `SKILL.md` 작성 (YAML frontmatter 필수):

```yaml
---
name: skill-name           # 폴더명과 반드시 일치
description: "Use when: ... Covers: ..."  # 키워드 풍부하게 작성
argument-hint: "선택적 힌트 텍스트"
---
```

3. `.claude/skills/<skill-name>/SKILL.md`에도 동일하게 복사:

```bash
cp -r .github/skills/<skill-name> .claude/skills/
```

4. `.github/copilot-instructions.md`의 스킬 파일 참조 섹션에 등록

---

## MCP 도구와 Skills의 차이

| 구분 | Skills | MCP 도구 |
|------|--------|----------|
| 목적 | 개발 워크플로 가이드 | 시스템 데이터 접근 |
| 형태 | 마크다운 절차 문서 | 함수 호출 API |
| 예시 | "YOLOv8 모델 교체 방법" | `mcp_lts_get_active_alerts()` |
| 위치 | `.github/skills/` | MCP 서버 (`mcp-server/`) |

---

## 관련 파일

- [.github/copilot-instructions.md](.github/copilot-instructions.md) — Copilot 전역 지침
- [CLAUDE.md](../CLAUDE.md) — Claude AI 프로젝트 컨텍스트
- [mcp-server/SYSTEM_PROMPT.md](../mcp-server/SYSTEM_PROMPT.md) — MCP 서버 시스템 프롬프트
- [mcp-server/README.md](../mcp-server/README.md) — MCP 서버 설정 가이드
