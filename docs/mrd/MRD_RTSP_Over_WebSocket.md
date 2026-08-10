# MARKET REQUIREMENTS DOCUMENT (MRD)
# RTSP-over-WebSocket 스트리밍 경로

| | |
|---|---|
| **Document Reference** | MRD-LTS2026-RTSPWS-01 |
| **Product** | LTS-2026 Loitering Detection & Tracking System |
| **Feature** | RTSP-over-WebSocket 3번째 카메라 재생 경로 |
| **Version** | 1.2 |
| **Date** | 2026-07-22 |
| **Status** | Active |
| **Related Design** | [Design_RTSP_Over_WebSocket.md](../design/Design_RTSP_Over_WebSocket.md) |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## 1. Executive Summary

LTS-2026의 카메라 재생 경로는 현재 두 가지뿐입니다 — AI 추론용으로 인코딩된 **JPEG Capture 스트리밍**(저지연이지만 프레임레이트·화질이 제한적)과 **WebRTC**(mediasoup SFU 또는 MediaMTX WHEP, 고화질·저지연이지만 브라우저 ICE/방화벽 이슈에 취약할 수 있음). 두 경로 모두 카메라 원본 스트림 자체를 브라우저가 직접 다루지는 않습니다.

이 기능은 Hanwha(Wisenet) `<rtsp-over-websocket>` 웹 컴포넌트를 이용해 **RTSP를 WebSocket으로 감싸 브라우저가 직접 재생**하는 세 번째 경로를 추가합니다. Hanwha SUNAPI 생태계(`/StreamingServer`)와 동일한 프로토콜을 로컬에서 재현함으로써, 카메라 제조사 네이티브 뷰어와 동일한 재생 경험을 웹 대시보드 안에서 제공하는 것이 목적입니다.

---

## 2. 시장 / 운영상 필요성

| Pain Point | Impact |
|---|---|
| JPEG 스트리밍은 ~10 FPS 스냅샷 합성 방식이라 화질·프레임레이트가 원본 RTSP 대비 제한적 | 세밀한 동작 확인(예: 얼굴 특징, 빠른 움직임)이 어려움 |
| WebRTC(mediasoup/MediaMTX)는 SDP 협상·ICE/STUN/TURN 구성에 의존해 방화벽·NAT 환경에서 연결 실패 가능성이 있음 | 일부 현장에서 WebRTC 재생이 아예 불가능하거나 관리자가 별도 ICE 설정을 해야 함 |
| Hanwha(Wisenet) 카메라·NVR을 사용하는 현장은 제조사 자체 웹뷰어(`<rtsp-over-websocket>`)와 동일한 재생 방식을 기대하는 경우가 있음 | LTS 대시보드가 제조사 생태계와 이질적인 재생 경험을 제공 |
| RTSP 원본 스트림 품질(해상도/비트레이트)을 그대로 보고 싶은 운영자가 JPEG/WebRTC 변환 경로를 거치지 않는 대안을 원함 | 트랜스코딩 없는 저부하 재생 옵션 부재 |

---

## 3. 대상 세그먼트

| 사용자 | 컨텍스트 |
|---|---|
| Hanwha/Wisenet 카메라·NVR 운영 현장의 보안 운영자 | 제조사 네이티브 뷰어와 동일한 RTSP-over-WebSocket 재생 경험을 LTS 대시보드 안에서 기대 |
| 방화벽/NAT 제약이 있는 현장의 시스템 관리자 | WebRTC ICE 협상이 어려운 환경에서 대체 재생 경로 필요 |
| 화질을 우선하는 운영자 | JPEG 변환 없이 원본에 가까운 스트림을 보고 싶은 경우 |

---

## 4. 사업 요구사항 (Business Requirements)

| ID | Requirement |
|---|---|
| BR-01 | 카메라 Add/Edit 화면에서 재생 경로를 JPEG(기본) / WebRTC / RTSP-over-WebSocket 3가지 중 선택할 수 있어야 한다 |
| BR-02 | RTSP-over-WebSocket 경로 추가로 인해 ingest-daemon의 카메라별 단일 RTSP 세션 원칙(§ CLAUDE.md "ingest-daemon 우선 원칙")이 깨져서는 안 된다 — 카메라에 신규 세션이 추가되지 않아야 한다 |
| BR-03 | RTSP-over-WebSocket 재생을 보는 브라우저 뷰어 수와 무관하게 카메라 쪽 RTSP 세션은 항상 1개로 유지되어야 한다 |
| BR-04 | RTSP-over-WebSocket 경로는 실제로 뷰어가 RTSP-over-WebSocket로 재생을 시작할 때만 관련 리소스(ingest-daemon fan-out)를 활성화하고, 마지막 뷰어가 종료되면 리소스를 해제해야 한다(on-demand) — 상시 카메라마다 추가 부하가 발생해서는 안 된다 |
| BR-05 | RTSP-over-WebSocket 재생 인증은 별도 인증 체계 신설 없이 카메라별로 이미 저장된 RTSP 자격증명(username/password)을 재사용해야 한다 |
| BR-06 | RTSP-over-WebSocket 경로는 원본 카메라의 SUNAPI 지원 여부(`supportSunapi`)와 무관하게 모든 RTSP 카메라에 노출되어야 한다 — 로컬 프록시가 재서빙하므로 원본 카메라 제약이 게이팅 조건이 되지 않는다 |
| BR-07 | YouTube 카메라는 RTSP-over-WebSocket 대상에서 제외한다(원본 카메라 개념이 없어 SUNAPI 프로토콜 재현이 성립하지 않음) |

---

## 5. 성공 지표

- RTSP-over-WebSocket로 카메라를 시청하는 브라우저 세션 수와 무관하게, 해당 카메라의 ingest-daemon RTSP 세션 수가 항상 1개로 유지됨 (세션 증식 0건)
- RTSP-over-WebSocket 뷰어가 모두 종료된 후 ingest-daemon의 채널별 fan-out(로컬 MediaMTX publish)이 자동으로 정리됨 (유휴 리소스 누적 0건)
- WS↔TCP 릴레이 계층의 CPU 사용량이 무시 가능한 수준(순수 바이트 복사, 트랜스코딩 없음)임을 실측으로 확인
- JPEG/WebRTC 각 재생 경로와 동일한 Add/Edit UX 안에서 운영자가 추가 학습 없이 RTSP-over-WebSocket를 선택할 수 있음

---

## 6. Out of Scope

- YouTube/RTMP/HLS 소스에 대한 RTSP-over-WebSocket 지원 (§4 BR-07)
- `/StreamingServer` 프로토콜 자체의 재해석/확장 — Hanwha SUNAPI 표준 RTSP-over-TCP-interleaved-over-WS 프레이밍(Design 문서 §2.4)을 그대로 릴레이할 뿐, 신규 프로토콜을 정의하지 않는다
- 카메라 원본이 SUNAPI를 지원하지 않는 경우에도 원본 카메라에 대한 `/StreamingServer` 직접 연결 — 항상 로컬 RTSP Proxy(MediaMTX) 경유
- WS 브릿지 계층의 JWT 등 신규 인증 체계 도입(§4 BR-05 — 기존 카메라 자격증명 재사용으로 확정)
- `melchi45/rtsp-over-websocket`의 `.gitmodules` 자체(HTTPS URL) 수정 — 이 저장소가 아닌 `rtsp-over-websocket` 리포 쪽 관리 사항 (Design 문서 §5 항목 5)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-22 | 초기 작성 |
| 1.1 | 2026-08-04 | 클라이언트 라이브러리를 `melchi45/rtsp-over-websocket` 서브모듈에서 `@melchi45/rtsp-over-websocket` npm 패키지로 전환 — Design_RTSP_Over_WebSocket.md §8.21 참고 |
| 1.2 | 2026-08-10 | 문서 ID `MRD-LTS2026-UMP-WS-01` → `MRD-LTS2026-RTSPWS-01`로 통일(연관 SRS/TC 추적 ID 리네임과 일관성 맞춤); 잔존 레거시 명칭 일괄 정리 — `Ump*` 식별자·`submodules/rtsp-over-websocket` 경로를 `@melchi45/rtsp-over-websocket` npm 패키지의 현행 명칭(`RTSPOverWebSocket*`, 별도 저장소 `melchi45/rtsp-over-websocket`)으로 전면 교체 |
