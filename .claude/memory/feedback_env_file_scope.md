---
name: feedback-env-file-scope
description: Never treat or edit server/.env.* example files as live config — only server/.env is loaded
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 541ebcfa-cbc6-4d9e-bef6-62a40ae1a27d
---

All server modes (`combined`/`streaming`/`analysis`) load configuration from a single `server/.env` file only. `server/.env.example`, `server/.env.streaming.example`, `server/.env.analysis.example` are reference-only documentation the server never loads.

**Why:** Project convention (`.claude/skills/docker-deploy/SKILL.md` "환경변수 파일 규칙") explicitly states: "Claude 등 AI 도구는 `.env` 이외의 `.env.*` 파일을 설정 파일로 취급하거나 수정하지 않습니다." — AI tools must not treat or edit any `.env.*` file other than `.env` as live configuration.

**How to apply:** When asked to change server config, edit only `server/.env`. Do not "helpfully" sync changes into the `.env.*.example` files unless the user explicitly asks for documentation updates there. `server/.env` itself may be edited directly when a task calls for it — this rule only restricts touching the `.example` variants and other historical mode-specific mechanisms (e.g. the removed `LTS_ENV_FILE=.env_streaming` pattern; `SERVER_MODE` is now set directly inside `server/.env`, never via a `LTS_ENV_FILE=` npm-script argument). After implementing a feature, check whether related settings already in `server/.env` (e.g. `WEBRTC_ENGINE`, `CAPTURE_BACKEND`) still match the new behavior and update them if not.
