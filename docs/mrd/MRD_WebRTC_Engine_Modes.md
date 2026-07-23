# MRD — WebRTC Engine Selection (mediamtx vs mediasoup)

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** `WEBRTC_ENGINE` 선택형 브라우저 실시간 영상 전달 백엔드
**Version:** 1.0
**Date:** 2026-07-23
**Author:** LTS Engineering Team

---

## 1. Executive Summary

LTS-2026은 브라우저에 카메라 영상을 WebRTC로 전달하는 백엔드를 `WEBRTC_ENGINE` 환경변수로 교체 가능하도록 설계했다(`mediamtx` | `mediasoup` | `werift`). 두 가지가 실제로 운영 가능한 상태로 구현되어 있으며, 이 프로젝트의 실 배포 환경에서 두 엔진 모두를 운영해 본 결과 **mediasoup 사용 시 영상이 끊기고 재생이 잘 안 되는 문제가 반복 관측**되었고, **mediamtx로 전환한 이후에는 안정적으로 재생**되는 것이 확인되었다. 이 MRD는 그 운영 관찰을 근거로 mediamtx를 기본 엔진으로 유지하기로 한 결정과, mediasoup 코드를 삭제하지 않고 dormant 상태로 보존하는 근거를 정리한다.

---

## 2. Operational Need

| Pain Point | Impact |
|---|---|
| mediasoup 모드에서 브라우저 영상이 간헐적으로 끊기거나 아예 재생되지 않음 (사용자 직접 보고) | 운영자가 실시간 모니터링 화면을 신뢰할 수 없음 — 배회 감지 시스템의 핵심 가치(실시간 확인)가 훼손됨 |
| 두 엔진이 코드상 공존하지만 어느 쪽이 "현재 실제로 도는지"가 `.env` 한 줄에만 담겨 있어, 신규 투입 인력이나 LLM 어시스턴트가 코드만 보고는 활성 경로를 오판하기 쉬움 | 잘못된 디버깅 방향(비활성 엔진 코드를 붙잡고 원인 분석) 소요 시간 낭비 |
| mediasoup 경로는 H.265 카메라를 원천적으로 지원하지 못함(mediasoup 자체 제약) | 혼합 카메라 fleet(HEVC + H.264)에서 mediasoup을 기본으로 쓰면 일부 카메라가 항상 재생 불가 |
| mediasoup 경로는 브라우저별 RTP payload type(PT) 불일치를 그때그때 해결해야 하는 alt-PT Router 캐시 메커니즘이 필요할 만큼 구조적으로 복잡함 | 신규 브라우저/OS 조합에서 재생이 안 될 때마다 원인 조사 비용이 mediamtx 대비 훨씬 큼 |

---

## 3. Target Users

| User | Context |
|---|---|
| 보안 운영자(Security Operator) | 대시보드에서 다중 카메라 영상을 실시간으로 지켜보며 이상행동을 즉시 확인해야 함 — 끊기는 영상은 곧 놓친 이벤트를 의미 |
| System Administrator | `server/.env`의 `WEBRTC_ENGINE` 값을 배포 환경별로 판단해 설정하고, 문제 발생 시 어느 엔진이 원인인지 신속히 특정해야 함 |
| Field Engineer | 카메라의 동시 RTSP 세션 제한이 엄격한 사이트(예: 접속 1개만 허용하는 저가형 IP 카메라)에서는 mediasoup의 "단일 RTSP 접속" 특성이 유리할 수 있어, 향후 재검토 여지를 남겨야 함 |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | 시스템은 `WEBRTC_ENGINE` 환경변수만으로 mediamtx/mediasoup 두 백엔드를 무중단 코드 변경 없이 전환할 수 있어야 한다(재시작은 필요). |
| BR-02 | 기본값(미설정 시)은 안정성이 실측으로 검증된 `mediamtx`여야 한다. |
| BR-03 | mediasoup 관련 코드는 현재 dormant 상태이더라도 삭제하지 않고 유지해야 한다 — 향후 동시 RTSP 세션 제한이 엄격한 사이트나 DataChannel 기반 저지연 App RTP가 필수인 사이트에서 재검토될 수 있다. |
| BR-04 | 두 엔진의 아키텍처·트레이드오프·실측 비교 결과는 신규 투입 인력이나 LLM 어시스턴트가 코드만 보지 않고도 파악할 수 있도록 문서화되어야 한다(SDLC 문서 전 계층). |
| BR-05 | H.265/HEVC 카메라가 혼재된 사이트는 mediasoup을 기본 엔진으로 선택해서는 안 된다는 제약이 운영 가이드에 명시되어야 한다. |

---

## 5. Success Metrics

- mediamtx를 기본 엔진으로 사용하는 배포에서 "영상이 끊긴다"는 운영자 신고 0건 유지
- `WEBRTC_ENGINE` 전환이 필요한 경우, 운영 가이드(`docs/ops/WebRTC_Engine_Modes_Guide.md`)만 보고 코드를 읽지 않고도 전환·복구 가능
- 두 엔진의 실제 데이터 흐름을 묻는 질문(사람/LLM 무관)에 대해 Design 문서 §2/§9 비교표만으로 정확히 답변 가능

---

## 6. Decision Record

| 날짜 | 관측/결정 | 근거 |
|---|---|---|
| 2026-07 이전 | `WEBRTC_ENGINE=mediasoup`로 운영 | mediasoup은 카메라당 RTSP 접속을 1회로 줄일 수 있어 초기 설계 시 선호됨 |
| 2026-07 (사용자 직접 보고) | mediasoup 모드에서 "영상이 끊기고 잘 안 보인다" | 실측 관측 — 재현성 있게 발생 |
| 2026-07-23 | `server/.env`를 `WEBRTC_ENGINE=mediamtx`로 전환, 기본값으로 고정 | 전환 직후 "아주 잘 보임" 확인(사용자 실측) — Design_WebRTC_Engine_Modes.md §9 참조 |
| 2026-07-23 | mediasoup 코드는 삭제하지 않고 보존, 문서에 dormant 상태임을 명시 | BR-03 — 향후 재검토 여지 보존, 코드 손실 방지 |

---

## 7. Out of Scope

- mediasoup 안정성 문제의 근본 원인(예: Worker 스케줄링 지연, PT 불일치 빈도)에 대한 추가 계측·수정 — 이번 결정은 "실측상 mediamtx가 더 안정적이었다"는 관찰에 기반한 운영 판단이며, mediasoup 자체의 버그 수정은 범위 밖이다.
- `werift` 엔진의 구현 완료 — 현재 스텁 상태이며 이 MRD의 범위가 아니다.
- Object Storage 녹화, Playback API 등 WebRTC 게이트웨이의 다른 미구현 기능(M1~M5, `RFP_RTSP_WebRTC_Architecture.md` 참조) — 이 MRD는 엔진 선택 그 자체에 한정된다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 — mediamtx/mediasoup 실측 비교 및 mediamtx 기본 엔진 유지 결정 근거 정리 |
