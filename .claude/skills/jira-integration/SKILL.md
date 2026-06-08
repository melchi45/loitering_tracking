---
name: jira-integration
description: "LTS-2026 테스트 실패를 Jira Issue로 자동 등록. Use when: 테스트 실패 시 Jira 이슈 자동 생성, TC 문서와 Jira 이슈 연동, GitHub Actions test-jira.yml 설정, JIRA_API_TOKEN 등 Secrets 구성, TC 문서 ID와 테스트 파일 매핑 수정, 중복 이슈 방지 로직 수정, dry-run으로 이슈 생성 시뮬레이션. Covers: test/jira-reporter.js, .github/workflows/test-jira.yml, GitHub Secrets, Jira REST API v3."
argument-hint: "작업 유형 (예: secrets-setup, tc-mapping, dry-run, workflow-trigger)"
---

# Jira Integration (Test → Issue)

## 전체 흐름

```
GitHub Actions (test-jira.yml)
  └─► Jest 테스트 실행 → jest-results.json
        └─► test/jira-reporter.js
              ├─► SUITE_TC_MAP으로 테스트 파일 → TC 문서 ID 매핑
              ├─► 중복 이슈 확인 (기존 Open 이슈 재사용)
              └─► Jira REST API v3 POST /issue → 이슈 생성
```

## 핵심 파일 위치

| 파일 | 역할 |
|---|---|
| `test/jira-reporter.js` | 핵심 스크립트: Jest JSON → Jira 이슈 생성 |
| `.github/workflows/test-jira.yml` | 자동화 워크플로 (테스트 실패 시 트리거) |
| `docs/tc/` | TC 문서 (Document ID 정의) |
| `test/reports/jira-issues.json` | 이슈 등록 결과 (자동 생성) |

## GitHub Secrets 설정 (필수)

GitHub 저장소 → Settings → Secrets and variables → Actions:

| Secret 이름 | 값 예시 | 설명 |
|---|---|---|
| `JIRA_BASE_URL` | `https://your-org.atlassian.net` | Jira 인스턴스 URL |
| `JIRA_USER_EMAIL` | `ci-bot@your-org.com` | Jira 계정 이메일 |
| `JIRA_API_TOKEN` | `ATATxxxxxxxx` | Atlassian API 토큰 |
| `JIRA_PROJECT_KEY` | `LTS` | Jira 프로젝트 키 |
| `JIRA_COMPONENT` | `LTS-2026` | 컴포넌트 이름 (선택) |

### Atlassian API 토큰 발급
1. https://id.atlassian.com/manage-profile/security/api-tokens 접속
2. "Create API token" 클릭
3. 생성된 토큰을 `JIRA_API_TOKEN` Secret에 저장

## 로컬 테스트 실행

```bash
# 1. 환경변수 설정
export JIRA_BASE_URL=https://your-org.atlassian.net
export JIRA_USER_EMAIL=your@email.com
export JIRA_API_TOKEN=your-token
export JIRA_PROJECT_KEY=LTS

# 2. 테스트 실행 후 JSON 결과 생성
cd server
npx jest --json --outputFile=../test/reports/jest-results.json --forceExit || true

# 3. Jira 이슈 등록 (dry-run으로 먼저 확인)
node test/jira-reporter.js --input test/reports/jest-results.json --dry-run

# 4. 실제 등록
node test/jira-reporter.js --input test/reports/jest-results.json
```

## 워크플로 트리거 조건

| 조건 | 동작 |
|---|---|
| `LTS-2026 Test Suite` 워크플로 실패 | 자동 실행 |
| `workflow_dispatch` 수동 실행 | 언제든 실행 가능 |
| 테스트 전부 통과 | 이슈 생성 없음 (정상 종료) |

## 생성되는 Jira 이슈 형태

```
요약: [TC-LTS-AI-01] 테스트 실패: human_detection
유형: Bug
레이블: lts-2026, automated, test-failure, tc-lts-ai-01
설명:
  - 테스트 파일: test/api/human_detection.test.js
  - TC 문서: docs/tc/TC_AI_Human_Detection.md
  - 실패한 테스트 목록 (N건)
  - 첫 번째 오류 메시지
  - CI 실행 링크
```

## TC 문서 ID 매핑 수정

`test/jira-reporter.js`의 `TC_DOC_IDS` 객체에서 관리:

```js
const TC_DOC_IDS = {
  'TC_AI_Human_Detection.md': 'TC-LTS-AI-01',
  'TC_Object_Tracking.md':    'TC-LTS-TRACK-01',
  // ...
};
```

새 TC 문서 추가 시:
1. `docs/tc/` 에 TC 파일 생성
2. `TC_DOC_IDS`에 매핑 추가
3. `SUITE_TC_MAP`에 테스트 파일 ↔ TC 매핑 추가

## 중복 이슈 방지

- 등록 전 JQL로 `summary ~ "TC-LTS-AI-01"` AND `statusCategory != Done` 검색
- 기존 Open 이슈 존재 시 새 이슈 생성 생략 (기존 키 반환)
- 해결(Done)된 이슈는 재오픈 대신 신규 생성

## 관련 파일
- [test/jira-reporter.js](../../../test/jira-reporter.js)
- [.github/workflows/test-jira.yml](../../../.github/workflows/test-jira.yml)
- [.github/workflows/test.yml](../../../.github/workflows/test.yml)
- [docs/tc/](../../../docs/tc/) — TC 문서 디렉토리

## 관련 문서 (SDLC 참조)

> **TC 문서가 Jira 이슈 제목·레이블의 원천**입니다. TC 문서 변경 시 `jira-reporter.js` 매핑도 함께 업데이트하세요.

| 구분 | 문서 |
|------|------|
| RFP | [RFP_LLM_MCP_Integration](../../../docs/rfp/RFP_LLM_MCP_Integration.md) · [RFP_LTS2026_Loitering_Tracking_System](../../../docs/rfp/RFP_LTS2026_Loitering_Tracking_System.md) |
| TC (전체) | [`docs/tc/`](../../../docs/tc/) — 모든 TC 문서; `TC_DOC_IDS` 매핑의 기준 |
| SRS | [SRS_LTS2026_Loitering_Tracking_System](../../../docs/srs/SRS_LTS2026_Loitering_Tracking_System.md) — TC 요구사항 추적성 원본 |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 사항 |
|-----------|------------------|
| `test/jira-reporter.js` → `TC_DOC_IDS` 추가 | `docs/tc/TC_xxx.md` 신규 문서 먼저 작성 |
| `test/jira-reporter.js` → `SUITE_TC_MAP` 추가 | 대응 `test/api/xxx.test.js` 파일 존재 확인 |
| `.github/workflows/test-jira.yml` 트리거 조건 변경 | 워크플로 주석에 변경 이유 기록 |
| 새 TC 문서 (`docs/tc/TC_xxx.md`) 추가 | `TC_DOC_IDS`에 Document ID 매핑 추가 |
| Jira 프로젝트 키 변경 | GitHub Secrets (`JIRA_PROJECT_KEY`) + 워크플로 업데이트 |

**공통 규칙**
- TC 문서 ID(`TC-LTS-AI-01` 형식)는 `docs/tc/` 문서 헤더에서 관리; `jira-reporter.js`는 이를 참조만 함
- TC 문서 삭제 시 → `TC_DOC_IDS`에서도 제거 (삭제된 ID로 Jira 이슈 생성 방지)
- 새 Jira 컴포넌트 추가 시 → GitHub Secrets `JIRA_COMPONENT` + 워크플로 문서 주석 업데이트
