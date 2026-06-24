# REQUEST FOR PROPOSAL
# ONVIF Metadata Pipeline — App RTP 기반 카메라 이벤트 수집

| | |
|---|---|
| **Document ID** | RFP-LTS-ONVIF-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-24 |
| **Issuer** | LTS-2026 프로젝트 팀 |
| **Related PRD** | [PRD_ONVIF_Metadata_Pipeline.md](../prd/PRD_ONVIF_Metadata_Pipeline.md) |
| **Related SRS** | [SRS_ONVIF_Metadata_Pipeline.md](../srs/SRS_ONVIF_Metadata_Pipeline.md) |
| **Related Design** | [Design_ONVIF_Metadata_Pipeline.md](../design/Design_ONVIF_Metadata_Pipeline.md) |

---

## 1. 개요 및 목적

LTS-2026 배회 감지·추적 시스템은 IP 카메라로부터 영상 스트림을 수집하는 동시에,
카메라 자체가 생성하는 **ONVIF 이벤트** (모션 감지, 라인 크로싱, 오디오 알람, 온도 알람 등)를
실시간으로 수집·저장·표시할 수 있어야 합니다.

Samsung, Hanwha, 기타 ONVIF 호환 IP 카메라는 RTSP 스트림의 **Application/Data 트랙**을 통해
**ONVIF MetadataStream XML**을 RTP 페이로드로 전달합니다.
본 RFP는 해당 Application RTP(AppRTP) 채널에서 ONVIF 이벤트를 안정적으로 수집하고
브라우저 대시보드에 표시하는 기능의 개발을 요청합니다.

---

## 2. 배경 및 필요성

### 2.1 문제 상황

기존 시스템은 AI 파이프라인(YOLOv8)이 생성하는 감지 이벤트만 처리합니다.
그러나 실제 운영 현장에서는 카메라 내장 이벤트(모션 감지, 콜 버튼 누름, 탬퍼링 등)를
별도로 기록해야 하는 요구사항이 있으며, 이를 위해 카메라가 RTSP App RTP 트랙으로
전송하는 ONVIF MetadataStream을 처리해야 합니다.

### 2.2 기술적 배경

- ONVIF (Open Network Video Interface Forum) 표준은 IP 카메라 이벤트 전달 방식을
  `wsnt:NotificationMessage` XML 구조로 정의합니다.
- Samsung IP 카메라는 이 XML을 RTSP `application/data` 트랙의 RTP 페이로드로 전송합니다.
- 기존 PyAV 기반 수집 데몬(`ingest_daemon.py`)은 영상/음성 트랙만 처리하며,
  Application 트랙 수집 기능이 없습니다.

### 2.3 PyAV 버전 호환성 이슈

PyAV 신버전에서 `av.Container.read_timeout` 속성이 쓰기 불가(read-only)로 변경되어,
기존 방식(`inp.read_timeout = N`)이 `AttributeError`를 발생시킵니다.
이 오류는 App RTP 루프를 즉각 실패시키고, MediaMTX `maxReaders` 한도를 소진시킵니다.
따라서 `av.open()` 호출 시점에 `options["timeout"]`으로 전달하는 방식을 요구합니다.

---

## 3. 기능 요구사항 (RFP 수준)

### RF-ONVIF-001: Application RTP 트랙 수집

수집 데몬(`ingest_daemon.py`)은 RTSP 스트림의 video/audio 외 트랙(application/data/subtitle)을
Application RTP로 식별하고, 해당 트랙의 RTP 패킷을 수집해야 합니다.

**인수 기준:**
- `appRtpCallbackUrl` 설정 시 App RTP 수집 스레드 자동 시작
- 카메라에 Application 트랙 없을 경우 경고 없이 조용히 스레드 종료
- 수집 실패 시 지수 백오프(0.5s → 최대 5.0s) 재시도

### RF-ONVIF-002: RTP 패킷 HTTP 전달

수집된 RTP 패킷을 base64 인코딩하여 서버 내부 API로 HTTP POST 전달해야 합니다.

**전달 형식:**
```json
{
  "pt":        96,
  "timestamp": 12345,
  "seq":       0,
  "payload":   "<base64 인코딩 RTP 패킷>"
}
```

**인수 기준:**
- `seq` 값이 단조 증가
- `payload`가 유효한 base64 문자열

### RF-ONVIF-003: ONVIF XML 구조화 파싱

서버는 RTP 페이로드에서 ONVIF `MetadataStream` XML을 파싱하여
`wsnt:NotificationMessage` 블록별로 독립적으로 처리해야 합니다.

**인수 기준:**
- 단일 패킷에 여러 `NotificationMessage`가 있을 경우 각각 독립 파싱
- 표준 ONVIF 토픽 → `type/label/severity` 정규화
- Samsung 전용 namespace 변형 → 동등한 표준 type 정규화
- 알 수 없는 토픽 → 전체 경로를 `topicType`으로 처리 (누락 없음)

### RF-ONVIF-004: 이벤트 실시간 브로드캐스트

파싱된 ONVIF 이벤트를 Socket.IO를 통해 모든 연결된 브라우저로 실시간 전달해야 합니다.

**인수 기준:**
- `io.emit('appRtp', ...)` — 원시 RTP 패킷 브로드캐스트
- `io.emit('onvif:event', ...)` — 구조화 이벤트 브로드캐스트
- `io.emit('onvif:temperature', ...)` — 열상 온도 데이터 브로드캐스트 (dedup 없음)

### RF-ONVIF-005: 이벤트 중복 제거 및 DB 저장

동일 상태의 반복 이벤트를 제거(dedup)하여 DB에 저장해야 합니다.

**dedup 기준:** `cameraId + topic + sourceToken + state` 조합

**인수 기준:**
- 상태 변화 시에만 DB `onvif_events` 테이블 삽입
- 동일 상태 반복 시 무시 (중복 저장 없음)
- 열상 데이터(`BoxTemperatureReading`)는 dedup 없이 매 패킷 브로드캐스트

### RF-ONVIF-006: 이벤트 조회 REST API

저장된 ONVIF 이벤트를 조회할 수 있는 REST API를 제공해야 합니다.

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/onvif-events` | 이벤트 조회 (cameraId, type, severity, from, to, limit 필터) |
| `DELETE /api/onvif-events` | 이벤트 삭제 |
| `GET /api/onvif-event-types` | 이벤트 타입 레지스트리 조회 |
| `GET /api/onvif-snapshots` | 이벤트 발생 시점 스냅샷 이미지 조회 |

### RF-ONVIF-007: 브라우저 타임라인 UI

수집된 ONVIF 이벤트를 브라우저 대시보드에서 시각적으로 확인할 수 있어야 합니다.

**인수 기준:**
- Gantt 바 형식 타임라인으로 이벤트 기간 시각화
- 포인트 이벤트는 다이아몬드 마커로 표시
- 카메라별 이벤트 타입 레지스트리 표시
- 열상 카메라 온도 데이터 실시간 오버레이 표시

---

## 4. 비기능 요구사항

### NF-ONVIF-001: 안정성 — MediaMTX 세션 누수 방지

App RTP 루프가 반복 재시도하더라도 MediaMTX RTSP 리더 수가 `maxReaders`(기본 10)를
초과하지 않아야 합니다.

- `inp.close()`를 항상 호출하여 RTSP 세션 즉시 해제
- 재시도 시 지수 백오프로 연결 빈도 제한

### NF-ONVIF-005: 안정성 — MediaMTX 프록시 환경 ONVIF 데이터 수신 보장

MediaMTX를 RTSP 프록시로 사용하는 환경에서도 ONVIF 이벤트 및 열상 온도 데이터가 정상 수신되어야 합니다.

- App RTP 수집은 MediaMTX URL이 아닌 **원본 카메라 RTSP URL**을 사용
- AI 영상 캡처(MediaMTX 경유)와 ONVIF 메타데이터 수집(카메라 직접)이 독립된 연결로 동작
- ONVIF 타임라인(`OnvifTimelineOverlay`)과 열상 오버레이(`ThermalOverlay`)가 MediaMTX 환경에서도 정상 표시

### NF-ONVIF-002: 안정성 — PyAV 버전 독립성

PyAV 10.x, 11.x, 12.x 어느 버전에서도 동일하게 동작해야 합니다.

- `av.open(options={"timeout": ...})` 방식만 허용
- `inp.read_timeout = N` 방식 사용 금지

### NF-ONVIF-003: 성능 — 낮은 지연

ONVIF 이벤트가 카메라에서 발생한 후 브라우저에 표시되기까지 **2초 이내** 전달.

### NF-ONVIF-004: 종료 응답성

`_signal_stop()` 호출 후 App RTP 스레드가 **3초 이내** 종료.

---

## 5. 지원 카메라 및 이벤트 타입

### 5.1 지원 카메라

| 제조사 | 모델 | 이벤트 타입 |
|---|---|---|
| Samsung (Hanwha) | WiseNet Q, X, P 시리즈 | 모션, 라인 크로싱, 오디오, 화재/연기, 배회, 얼굴, LPR |
| Generic ONVIF | 표준 ONVIF Profile S/T | 모션, 탬퍼링, 디지털 입력, 릴레이 |
| 열상 카메라 | Radiometry 지원 모델 | BoxTemperatureReading, 온도 알람 |

### 5.2 지원 이벤트 토픽

| 토픽 | 의미 | 분류 |
|---|---|---|
| `tns1:VideoSource/tns1:MotionAlarm` | 표준 모션 감지 | warning |
| `tns1:Device/tns1:Trigger/CallRequest` | 콜 버튼 | info |
| `tns1:Device/tns1:Trigger/tns1:DigitalInput` | 디지털 입력 | info |
| `tns1:VideoAnalytics/tns1:Line/tns1:Crossed` | 라인 크로싱 | warning |
| `tns1:VideoAnalytics/tns1:Field/tns1:Entered` | 영역 진입 | warning |
| `tns1:AudioSource/tns1:DetectedSound` | 오디오 감지 | warning |
| `tns1:VideoSource/tns1:GlobalSceneChange/ImageTooDark` | 탬퍼 (어둠) | critical |
| `tns1:VideoAnalytics/Radiometry/BoxTemperatureReading` | 온도 읽기 | info |
| `tns1:VideoSource/RadiometryAlarm` | 온도 알람 | warning |
| `tnssamsung:IVA/Fire` | 화재 감지 | critical |
| `tnssamsung:IVA/LoiteringDetection` | 배회 감지 | warning |
| `tnssamsung:IVA/FaceDetection` | 얼굴 감지 | info |
| `tnssamsung:IVA/ObjectDetection` | 객체 감지 | info |
| `tnssamsung:IVA/LPR` | 번호판 인식 | info |

---

## 6. 범위 외 항목

- ONVIF WS-Discovery 자동 탐색 (별도 `onvifDiscovery.js` 담당)
- ONVIF PTZ 제어
- ONVIF 이벤트 구독 (SOAP/WS-Notification HTTP pull point) — RTSP App RTP만 해당
- RTSP 외 ONVIF 이벤트 수집 방식

---

## 7. 납품 요구사항

| 항목 | 요구 내용 |
|---|---|
| 구현 코드 | `ingest_daemon.py`, `internalApi.js`, `onvifParser.js`, `onvifApi.js` |
| 클라이언트 | `OnvifTimelineOverlay.tsx`, `ThermalOverlay.tsx` |
| 단위 테스트 | `test/ingest/test_apprtp.py`, `test/api/onvif_apprtp.test.js` |
| 통합 테스트 | `test/api/onvif_metadata_pipeline.test.js` |
| 설계 문서 | `docs/design/Design_ONVIF_Metadata_Pipeline.md` |
| SRS | `docs/srs/SRS_ONVIF_Metadata_Pipeline.md` |
| TC | `docs/tc/TC_ONVIF_Metadata_Pipeline.md` |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-24 | 초기 작성 — ONVIF App RTP 수집 파이프라인 RFP |
| 1.1 | 2026-06-24 | NF-ONVIF-005 추가 — MediaMTX 환경에서 ONVIF 이벤트·열상 온도 정상 수신 요구사항 |
