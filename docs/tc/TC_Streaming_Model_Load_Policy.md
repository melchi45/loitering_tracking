# TEST CASES (TC)
# Streaming Mode Model Load Policy

| | |
|---|---|
| **Document ID** | TC-LTS-DAP-02 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-08 |
| **Parent SRS** | [SRS_Distributed_AI_Pipeline](../srs/SRS_Distributed_AI_Pipeline.md) |
| **Related Test Script** | `test/api/streaming_mode_model_skip.test.js` |

---

## 1. 목적

`SERVER_MODE=streaming`에서 서버가 로컬 분석 모델(PAR/ArcFace/FireSmoke)을 시작 시 eager load 하지 않는 정책을 검증한다.

## 2. 테스트 케이스

| ID | 항목 | 입력/조건 | 기대 결과 |
|---|---|---|---|
| TC-SMLP-001 | eager-load 경로 차단 | `SERVER_MODE=streaming` + `PipelineManager.loadFaceServiceEagerly()` 호출 | `_attrPipeline` 생성되지 않음 |
| TC-SMLP-002 | 서버 시작 경로 차단 | `SERVER_MODE=streaming`로 서버 시작 | index 부트 로그에 eager model loading skip 메시지 출력 |
| TC-SMLP-003 | 원격 분석 연동 유지 | `SERVER_MODE=streaming`, `ANALYSIS_SERVER_URL` 유효 | 카메라 파이프라인은 원격 분석 결과로 detections/alerts/face_match 반영 |

## 3. 실행 명령

```bash
node test/api/streaming_mode_model_skip.test.js
```

## 4. 합격 기준

- `TC-SMLP-001` 통과 (`_attrPipeline === null`)
- streaming 서버 로그에서 로컬 모델 로딩 실패 로그(PAR/ArcFace eager load) 미발생
- 원격 분석 연동 기능은 기존대로 동작
