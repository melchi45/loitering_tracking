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

## 관련 설계 문서
- [Design_Dashboard_Layout.md](../../docs/design/Design_Dashboard_Layout.md)
- [Design_Dashboard_Detection_Display.md](../../docs/design/Design_Dashboard_Detection_Display.md)
- [Design_Dashboard_Sidebar_Cameras.md](../../docs/design/Design_Dashboard_Sidebar_Cameras.md)
- [Design_Dashboard_Sidebar_Alerts_Zones.md](../../docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md)
- [Design_Mobile_Layout.md](../../docs/design/Design_Mobile_Layout.md)
- [Design_Stats_Panel.md](../../docs/design/Design_Stats_Panel.md)
- [Design_Dashboard_Search_Fullscreen.md](../../docs/design/Design_Dashboard_Search_Fullscreen.md)
