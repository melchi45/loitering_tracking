---
name: react-dashboard-dev
description: "LTS-2026 React/TypeScript 대시보드 UI 개발. Use when: 대시보드 컴포넌트 추가/수정, Zustand 스토어 상태 관리, WebSocket 실시간 이벤트 수신, Tailwind CSS 스타일링, 카메라 그리드 뷰 수정, 알림 패널 UI 개선, 구역 편집기 수정, i18n 다국어 텍스트 추가, 검색 UI 구현, 모바일 반응형 레이아웃 조정, Vite 빌드 오류 수정. Covers: client/src/ React components, Zustand stores, hooks, i18n, Vite, Tailwind."
argument-hint: "수정할 UI 영역 (예: camera-grid, alert-panel, zone-editor, face-gallery)"
---

# React Dashboard Development

## 클라이언트 아키텍처

```
client/src/
├── App.tsx                 — 라우팅 루트, 글로벌 레이아웃
├── pages/
│   ├── SignInPage.tsx       — 로그인 (MSAL / 로컬 인증)
│   └── admin/              — 관리자 페이지
├── components/
│   ├── CameraGrid.tsx       — 다중 카메라 타일 그리드
│   ├── CameraView.tsx       — 단일 카메라 WebRTC 뷰 + 오버레이
│   ├── AlertPanel.tsx       — 실시간 알림 목록
│   ├── ZonesPanel.tsx       — 구역 목록 사이드바
│   ├── ZoneEditor.tsx       — 캔버스 기반 구역 다각형 편집
│   ├── FaceGalleryTab.tsx   — 등록 얼굴 갤러리
│   ├── SearchFullscreen.tsx — 전체화면 감지 검색
│   ├── StatsPanelModal.tsx  — 분석 통계 모달
│   └── DashboardDetectionPanel.tsx — 감지 결과 패널
├── stores/                 — Zustand 상태 스토어
├── hooks/                  — 커스텀 훅
└── i18n/                   — 다국어 리소스
```

## Zustand 스토어 목록

| 스토어 | 관리 상태 |
|---|---|
| `cameraStore.ts` | 카메라 목록, 연결 상태, 활성 스트림 |
| `alertStore.ts` | 활성 알림, 필터, acknowledge 상태 |
| `crossCameraStore.ts` | 크로스 카메라 추적 동선 데이터 |
| `discoveryStore.ts` | ONVIF 탐색 결과 |
| `personTrajectoryStore.ts` | 인물 이동 궤적 히스토리 |
| `authStore.ts` | 사용자 인증 상태, 토큰 |
| `webrtcConfigStore.ts` | ICE/STUN/TURN 설정 |

## 주요 작업 절차

### 새 컴포넌트 추가
1. `client/src/components/` 에 `.tsx` 파일 생성
2. Tailwind CSS 클래스로 스타일링 (별도 CSS 파일 불필요)
3. 필요한 Zustand 스토어 import 및 훅 사용
4. `App.tsx` 또는 부모 컴포넌트에 등록

### WebSocket 실시간 이벤트 수신
```tsx
// 커스텀 훅 패턴 (client/src/hooks/)
import { useEffect } from 'react';
import { useAlertStore } from '../stores/alertStore';

export function useAlertSocket(socket: Socket) {
  const addAlert = useAlertStore(s => s.addAlert);
  useEffect(() => {
    socket.on('alert:new', (alert) => addAlert(alert));
    socket.on('alert:acknowledged', (id) => useAlertStore.getState().acknowledge(id));
    return () => { socket.off('alert:new'); socket.off('alert:acknowledged'); };
  }, [socket]);
}
```

### i18n 텍스트 추가
1. `client/src/i18n/` 폴더의 언어 파일 열기 (`ko.json`, `en.json` 등)
2. 새 키-값 쌍 추가:
   ```json
   { "zone.loiteringAlert": "배회 감지 알림" }
   ```
3. 컴포넌트에서 사용:
   ```tsx
   import { useTranslation } from 'react-i18next';
   const { t } = useTranslation();
   <span>{t('zone.loiteringAlert')}</span>
   ```

### Tailwind 커스텀 스타일
- 설정 파일: `client/tailwind.config.js`
- 커스텀 색상·브레이크포인트 추가 시 `theme.extend` 섹션 수정
- 다크모드: `dark:` 접두어 클래스 사용

### 카메라 그리드 레이아웃 수정
1. `client/src/components/CameraGrid.tsx` 열기
2. 그리드 열 수 변경: `grid-cols-2`, `grid-cols-3`, `grid-cols-4`
3. 반응형: `sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-4`

### 개발 서버 실행
```bash
cd client
npm run dev          # Vite dev server (기본 포트 3080)
npm run build        # 프로덕션 빌드
npm run preview      # 빌드 결과 미리보기
```

## TypeScript 타입 위치
- `client/src/types/` — 감지 결과, 알림, 카메라, 구역 등 공통 타입
- 서버 API 응답 타입은 이 폴더에서 정의 후 컴포넌트에서 import

## 관련 문서 (SDLC 참조)

> 구현·수정 전 아래 문서를 확인하고, **코드 변경 시 해당 문서를 반드시 동기화**하세요.

| 구분 | 문서 |
|------|------|
| PRD | [PRD_Dashboard_Layout](../../../docs/prd/PRD_Dashboard_Layout.md) · [PRD_Dashboard_Detection_Display](../../../docs/prd/PRD_Dashboard_Detection_Display.md) · [PRD_Dashboard_Sidebar_Cameras](../../../docs/prd/PRD_Dashboard_Sidebar_Cameras.md) |
| PRD | [PRD_Dashboard_Sidebar_Alerts_Zones](../../../docs/prd/PRD_Dashboard_Sidebar_Alerts_Zones.md) · [PRD_Dashboard_Sidebar_Face_ID](../../../docs/prd/PRD_Dashboard_Sidebar_Face_ID.md) · [PRD_Dashboard_Search_Fullscreen](../../../docs/prd/PRD_Dashboard_Search_Fullscreen.md) · [PRD_Mobile_Layout](../../../docs/prd/PRD_Mobile_Layout.md) · [PRD_Stats_Panel](../../../docs/prd/PRD_Stats_Panel.md) |
| SRS | [SRS_Dashboard_Layout](../../../docs/srs/SRS_Dashboard_Layout.md) · [SRS_Dashboard_Sidebar_Cameras](../../../docs/srs/SRS_Dashboard_Sidebar_Cameras.md) · [SRS_Dashboard_Sidebar_Alerts_Zones](../../../docs/srs/SRS_Dashboard_Sidebar_Alerts_Zones.md) · [SRS_Mobile_Layout](../../../docs/srs/SRS_Mobile_Layout.md) |
| Design | [Design_Dashboard_Layout](../../../docs/design/Design_Dashboard_Layout.md) · [Design_Dashboard_Detection_Display](../../../docs/design/Design_Dashboard_Detection_Display.md) · [Design_Dashboard_Sidebar_Cameras](../../../docs/design/Design_Dashboard_Sidebar_Cameras.md) |
| Design | [Design_Dashboard_Sidebar_Alerts_Zones](../../../docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md) · [Design_Dashboard_Sidebar_Face_ID](../../../docs/design/Design_Dashboard_Sidebar_Face_ID.md) · [Design_Dashboard_Search_Fullscreen](../../../docs/design/Design_Dashboard_Search_Fullscreen.md) · [Design_Mobile_Layout](../../../docs/design/Design_Mobile_Layout.md) · [Design_Stats_Panel](../../../docs/design/Design_Stats_Panel.md) |
| TC | [TC_Dashboard_Layout](../../../docs/tc/TC_Dashboard_Layout.md) · [TC_Dashboard_Detection_Display](../../../docs/tc/TC_Dashboard_Detection_Display.md) · [TC_Dashboard_Sidebar_Cameras](../../../docs/tc/TC_Dashboard_Sidebar_Cameras.md) · [TC_Dashboard_Sidebar_Alerts_Zones](../../../docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md) · [TC_Mobile_Layout](../../../docs/tc/TC_Mobile_Layout.md) |
| TC | [TC_Dashboard_Sidebar_Face_ID](../../../docs/tc/TC_Dashboard_Sidebar_Face_ID.md) · [TC_Detection_Snapshot_Search](../../../docs/tc/TC_Detection_Snapshot_Search.md) |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `CameraGrid.tsx`, `CameraView.tsx` | `docs/design/Design_Dashboard_Layout.md`, `docs/design/Design_Dashboard_Sidebar_Cameras.md`, `docs/tc/TC_Dashboard_Layout.md` |
| `AlertPanel.tsx` | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md`, `docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md` |
| `ZonesPanel.tsx`, `ZoneEditor.tsx` | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md`, `docs/srs/SRS_Dashboard_Sidebar_Alerts_Zones.md` |
| `FaceGalleryTab.tsx` | `docs/design/Design_Dashboard_Sidebar_Face_ID.md`, `docs/tc/TC_Dashboard_Sidebar_Face_ID.md` |
| `SearchFullscreen.tsx` | `docs/design/Design_Dashboard_Search_Fullscreen.md`, `docs/prd/PRD_Dashboard_Search_Fullscreen.md` |
| `StatsPanelModal.tsx` | `docs/design/Design_Stats_Panel.md`, `docs/prd/PRD_Stats_Panel.md` |
| `DashboardDetectionPanel.tsx` | `docs/design/Design_Dashboard_Detection_Display.md`, `docs/tc/TC_Dashboard_Detection_Display.md` |
| `i18n/translations/*.ts` | 해당 UI 컴포넌트의 Design 문서 UI 텍스트 섹션 |
| 새 컴포넌트 추가 | PRD + SRS + Design + TC 문서 신규 작성 또는 관련 문서에 섹션 추가 |

**공통 규칙**
- **새 UI 컴포넌트** → Design 문서에 UI 구조·상태·이벤트 흐름 추가, TC에 렌더링·인터랙션 케이스 추가
- **Zustand 스토어 변경** → SRS 데이터 모델 섹션 업데이트
- **API 연동 변경** → Design의 데이터 플로우 다이어그램 및 TC 업데이트
- **반응형 레이아웃 변경** → `docs/design/Design_Mobile_Layout.md` + `docs/tc/TC_Mobile_Layout.md` 업데이트
- **i18n 키 추가** → 해당 화면의 Design 문서 UI 텍스트 항목 추가
