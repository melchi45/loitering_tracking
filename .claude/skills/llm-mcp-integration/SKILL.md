---
name: llm-mcp-integration
description: "LTS-2026 MCP 서버 개발 및 도구 작성. Use when: MCP 도구 추가/수정, LLM에서 LTS 데이터 조회, mcp-server/ 파일 작업, MCP 테스트 실행, MCP HTTP/SSE 서버 관리. Covers: mcp-server/tools/, mcp-server/lts-client.js, create-server.js, 도구 등록 패턴, 서버 시작/중지 스크립트."
argument-hint: "작업 대상 (예: add-tool, test, start, stop, restart, query-cameras, query-events)"
---

# LLM / MCP Integration

## 아키텍처 개요

LTS-2026의 MCP 서버는 LLM(Claude/GPT 등)이 LTS REST API를 자연어로 조작할 수 있게 합니다.

```
Claude / GPT
    │ MCP protocol (stdio or HTTP/SSE)
    ▼
mcp-server/index.js        ← 전송 계층 (TRANSPORT=stdio|http)
    │
    ▼
create-server.js           ← McpServer 인스턴스 팩토리 (도구 등록)
    │
    ├── tools/loitering.js         query_loitering_events, get_tracking_history
    ├── tools/alerts.js            get_active_alerts, explain_alert, acknowledge_alert
    ├── tools/cameras.js           get_camera_status, get_zone_config, update_zone_threshold,
    │                              add_camera, update_camera, delete_camera, toggle_camera_ai
    ├── tools/analytics.js         get_analytics_summary, generate_security_report
    ├── tools/stats.js             get_stats_dashboard
    ├── tools/snapshots.js         get_object_snapshots
    ├── tools/system.js            get_server_status
    ├── tools/onvif.js             query_onvif_events, get_onvif_event_types
    ├── tools/detections.js        query_analysis_events, get_detection_tracks, get_analysis_metrics
    ├── tools/missing-person.js    register_missing_person, search_missing_person, ...
    ├── resources.js               lts://cameras, lts://alerts/active, lts://zones, lts://system/summary
    └── lts-client.js              LTS HTTP 클라이언트 (get/post/put/patch/delete)
```

## 도구 목록 (v1.1 — 21종)

### 시스템
| 도구 | 접근 | 설명 |
|---|---|---|
| `get_server_status` | read | LTS 서버 health, mode, uptime, DB, 카메라 수; `includeMetrics=true` 시 CPU/GPU |

### 배회/추적
| 도구 | 접근 | 설명 |
|---|---|---|
| `query_loitering_events` | read | 배회 이벤트 조회 (시간/카메라/체류시간 필터) |
| `get_tracking_history` | read | 특정 객체 추적 이력 전체 |

### 알림
| 도구 | 접근 | 설명 |
|---|---|---|
| `get_active_alerts` | read | 미확인 알림 목록 |
| `explain_alert` | read | 알림 상세 설명 (위험도/구역/객체 이력) |
| `acknowledge_alert` | write | 알림 확인 처리 |

### 카메라 & 구역
| 도구 | 접근 | 설명 |
|---|---|---|
| `get_camera_status` | read | 카메라 파이프라인 상태 |
| `get_zone_config` | read | 구역 다각형·임계값·스케줄 |
| `add_camera` | write | 신규 카메라 채널 등록 |
| `update_camera` | write | 카메라 설정 업데이트 |
| `delete_camera` | write | 카메라 삭제 (비가역) |
| `toggle_camera_ai` | write | AI 추론 ON/OFF |
| `update_zone_threshold` | write | 구역 체류 임계값 수정 |

### ONVIF 이벤트
| 도구 | 접근 | 설명 |
|---|---|---|
| `query_onvif_events` | read | ONVIF 이벤트 조회 (화재/움직임/라인크로싱 등) |
| `get_onvif_event_types` | read | 시스템 ever-seen topicType 레지스트리 |

### AI 감지 분석
| 도구 | 접근 | 설명 |
|---|---|---|
| `query_analysis_events` | read | AI 감지 이벤트(배회/화재/연기) 조회 |
| `get_detection_tracks` | read | 객체 감지 트랙 이력 |
| `get_analysis_metrics` | read | AI 파이프라인 메트릭 (FPS/GPU/모델) |

### 분석 & 리포트
| 도구 | 접근 | 설명 |
|---|---|---|
| `get_analytics_summary` | read | 이벤트 통계 요약 |
| `generate_security_report` | read | 보안 Markdown 리포트 |
| `get_stats_dashboard` | read | 시스템 전체 통계 대시보드 |
| `get_object_snapshots` | read | 추적 객체 JPEG 스냅샷 |

## 도구 추가 패턴

```javascript
// mcp-server/tools/my-module.js (ESM)
import { z } from 'zod';

export function registerMyTools(server, client) {
  server.tool(
    'my_tool_name',
    'One-sentence description for the LLM.',
    {
      param1: z.string().describe('설명'),
      param2: z.number().int().min(1).max(100).optional(),
    },
    async ({ param1, param2 = 10 }) => {
      try {
        const data = await client.get('/api/my-endpoint', { param1, limit: param2 });
        return { content: [{ type: 'text', text: `Result: ${JSON.stringify(data)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
```

도구 작성 후 `create-server.js`에 import + 호출 추가 필수:

```javascript
import { registerMyTools } from './tools/my-module.js';
// createServer() 내부:
registerMyTools(server, client);
```

`TOOL_CATALOG` 배열에도 추가:
```javascript
{ name: 'my_tool_name', access: 'read', description: '...' },
```

## MCP 서버 관리 명령어

```bash
cd server

# MCP HTTP 서버 시작/중지/재시작 (백그라운드 데몬)
npm run mcp:start     # TRANSPORT=http, 포트 MCP_PORT (기본 3002)
npm run mcp:stop      # 포트 + pgrep으로 프로세스 종료
npm run mcp:restart   # stop → start

# stdio 직접 실행 (Claude Code CLAUDE.md 연동)
node mcp-server/index.js   # TRANSPORT=stdio (기본)
```

### 환경 변수 (`server/.env`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `MCP_PORT` | `3002` | HTTP/SSE 포트 |
| `MCP_AUTH_TOKEN` | (없음) | Bearer 인증 토큰 (HTTP 전용) |
| `MCP_PUBLIC_URL` | (없음) | /schema 응답 base URL (ngrok 등 역방향 프록시용) |
| `MCP_SERVER_LOG` | `/tmp/mcp-server.log` | startMcpServer.js 로그 경로 |
| `LTS_BASE_URL` | `http://localhost:3080` | LTS API 서버 URL |

## Claude Code 연동 (`.claude/settings.json`)

```json
{
  "mcpServers": {
    "lts": {
      "command": "node",
      "args": ["mcp-server/index.js"],
      "env": { "LTS_BASE_URL": "http://localhost:3080" }
    }
  }
}
```

## 테스트

```bash
# 기존 MCP 도구 테스트 (Groups A~I)
node test/api/mcp_server.test.js

# 확장 도구 테스트 v1.1 (Groups J~N)
node test/api/mcp_server_extended.test.js

# 환경 변수로 서버 URL 지정
LTS_URL=http://localhost:3080 node test/api/mcp_server_extended.test.js
```

## 관련 문서

| 문서 | 경로 |
|---|---|
| Design (설계) | `docs/design/Design_LLM_MCP_Server.md` |
| PRD (제품 요구사항) | `docs/prd/PRD_LLM_MCP_Server.md` |
| SRS (기능 요구사항) | `docs/srs/SRS_LLM_MCP_Server.md` |
| TC (테스트 케이스) | `docs/tc/TC_LLM_MCP_Server.md` |
| RFP (기술 선정) | `docs/rfp/RFP_LLM_MCP_Integration.md` |
