# RFP — Mobile Layout (LTS2026-MOB)

**Document version:** 1.0  
**Date:** 2026-05-20  
**Status:** ✅ Implemented

---

## 1. Overview

모바일 환경(스마트폰 / 태블릿)에서 기존 데스크톱 UI의 컴포넌트를 **최대한 재사용**하면서,  
하단 네비게이션(Bottom Navigation) 기반의 모바일 친화적 레이아웃을 제공한다.

| 항목 | 데스크톱 | 모바일 |
|------|---------|--------|
| 사이드바 | 오른쪽 고정 패널 (드래그 리사이즈) | ❌ 없음 |
| 탭 위치 | 사이드바 상단 수평 탭 | 하단 고정 네비게이션 바 |
| 콘텐츠 영역 | Main(카메라 그리드) + Sidebar(탭 컨텐츠) | 단일 전체화면 영역 (탭 전환) |
| 카메라 그리드 | 독립 메인 영역 | Cameras 탭 내부 임베드 |
| 브레이크포인트 | ≥ 768px | < 768px |

---

## 2. Layout Structure

### 2.1 Mobile Screen Anatomy

```
┌─────────────────────────────────────┐
│  [LTS]  App Title          🔴 ⚙️  │  ← Header (44px, compact)
├─────────────────────────────────────┤
│                                     │
│                                     │
│         Content Area                │  ← flex-1, overflow-y-auto
│   (렌더링: 현재 선택된 탭 컨텐츠)      │
│                                     │
│                                     │
│                                     │
├─────────────────────────────────────┤
│  📷      🔔      🗺      👁      🤖  │  ← Bottom Navigation (52px, fixed)
│ Cameras Alerts Zones Detect  AI    │
└─────────────────────────────────────┘
```

### 2.2 Header (Mobile)

| 요소 | 설명 |
|------|------|
| LTS 로고 + 앱명 | 왼쪽 고정 |
| 연결 상태 dot | 로고 우측, 색상 코딩 (green/red) |
| `flex-1` spacer | 빈 공간 |
| 카메라 수 뱃지 | `N/M Live` 소형 텍스트 |
| 설정 아이콘 | 오른쪽 끝 (기존 Settings Modal 재사용) |
| 레이아웃 피커 | ❌ 숨김 (모바일에서 불필요) |

### 2.3 Content Area (Mobile)

각 탭 전환 시 해당 컨텐츠가 전체 영역을 차지한다.

| Tab | 모바일 컨텐츠 | 재사용 컴포넌트 |
|-----|-------------|----------------|
| 📷 Cameras | 상단: CameraGrid(기본 1채널, 스와이프로 코너스 전환) / 하단: CameraList 스크롤 | `CameraGrid`, `CameraList` |
| 🔔 Alerts | AlertPanel 전체화면 | `AlertPanel` |
| 🗺 Zones | Zone 안내 메시지 + 더블클릭 카메라 선택 힌트 | 기존 Zone 안내 JSX |
| 👁 Detections | 카메라 선택 드롭다운 + DetectionPanel | `DetectionPanel` |
| 🤖 Analytics | VideoAnalyticsTab 전체화면 | `VideoAnalyticsTab` |

### 2.4 Bottom Navigation Bar

```
┌──────────────────────────────────────────┐
│  📷      🔔      🗺      👁       🤖     │
│ Cameras  Alerts  Zones  Detect   AI     │
│ [active blue underline on selected tab] │
└──────────────────────────────────────────┘
```

- 높이: `h-13` (52px)
- 배경: `bg-gray-900 border-t border-gray-700`
- 아이콘 크기: `text-xl` (20px)
- 텍스트: `text-[9px]`, 선택 시 `text-blue-400`, 비선택 `text-gray-500`
- 알림 뱃지: Alerts 탭 아이콘 우상단 숫자 뱃지 (기존 데스크톱과 동일 로직)

---

## 3. Cameras Tab (Mobile)

### 3.1 레이아웃

```
┌─────────────────────────────────────┐
│  Header                             │
├─────────────────────────────────────┤
│                                     │
│    CameraGrid                       │
│    (상단 60% — 현재 레이아웃 기준)    │
│                                     │
├─────────────────────────────────────┤
│  CameraList (하단 40%)              │
│  ─ 카메라 항목 스크롤 목록            │
│  ─ 항목 클릭 → selectCamera         │
│  ─ 더블탭 → 전체화면 오버레이         │
├─────────────────────────────────────┤
│  Bottom Nav                         │
└─────────────────────────────────────┘
```

### 3.2 레이아웃 피커 (모바일용)

- **기본 레이아웃**: `1` (1채널 단일 화면)
- 화면 상단 우측에 소형 레이아웃 피커 버튼 (아이콘 only) 배치
- 1채널 (`1`) / 4채널 (`4`) / 9채널 (`9`) 간소화 옵션만 표시
- 레이아웃 변경 시 `channelOffset` 리셋

### 3.3 채널 페이지 스와이프 네비게이션

카메라 등록 수가 레이아웃 채널 수를 초과할 경우, 좌/우 스와이프로 채널 페이지를 전환한다.

#### 3.3.1 스와이프 영역

- **전체 Cameras 탭** (CameraGrid 상단 58% + CameraList 하단 42%) 모두 스와이프 감지
- `onTouchStart` / `onTouchEnd` 이벤트를 탭 루트 `div`에서 쳄치 → 그리드와 리스트 어디에서나 스와이프 유효

#### 3.3.2 동작 사양

| 속성 | 설명 |
|------|------|
| **방향** | 좌 스와이프 → 다음 페이지, 우 스와이프 → 이전 페이지 |
| **임계값** | 치실 수평 이동 거리 ≥ 40px |
| **이동 단위** | 현재 레이아웃의 채널 수(`def.channels`) |
| **상태** | `channelOffset` (App.tsx 로컈 state, 데스크톱과 공유) |

#### 3.3.3 페이지 인디케이터

```
┬─────────────────────────────────────┐
│  2/5          [Layout▼]  │  ← 좌상단: N/M 배지 / 우상단: 레이아웃 피커
│                          │
│     CameraGrid (58%)    │
│                          │
│       ● ○ ○ ○ ○           │  ← 하단 중앙: 도트 인디케이터
├─────────────────────────────────────┤
│  CameraList (42%)        │  ← 스크롤 목록 + 스와이프 유효 영역
└─────────────────────────────────────┘
```

- 페이지가 2개 이상일 때만 도트(●○) 및 N/M 배지 표시
- 현재 페이지 도트: `bg-blue-400`, 비활성: `bg-gray-600`

#### 3.3.4 동작 예시

카메라 5개 등록, 레이아웃 `1` (1채년):
```
페이지 5개 — 도트 5개 표시
좌 스와이프 → CAM2 표시 (offset=1)
좌 스와이프 → CAM3 표시 (offset=2)
우 스와이프 → CAM2 표시 (offset=1)
```

## 4. Detections Tab (Mobile)

```
┌─────────────────────────────────────┐
│  Camera  [드롭다운 선택]              │  ← 카메라 선택 드롭다운 (기존 재사용)
├─────────────────────────────────────┤
│  DetectionPanel                     │
│  ─ 카테고리 필터 바                  │
│  ─ 감지 목록 (스크롤)                │
│  ─ Cross-Camera Re-ID 피드          │
│  ─ 범례 (접힘/펼침)                  │
├─────────────────────────────────────┤
│  Bottom Nav                         │
└─────────────────────────────────────┘
```

---

## 5. Fullscreen Camera Overlay (Mobile)

기존 `FullscreenCameraView` 컴포넌트를 그대로 재사용.

- 더블탭(더블클릭) 시 `fullscreenCameraId` 설정 → 오버레이 표시
- 오버레이 닫기: `✕` 버튼 (기존 동일)
- DetectionPanel은 모바일에서 오버레이 하단 슬라이드 패널로 표시됨  
  (오버레이 내 레이아웃은 세로 분할: 상단 비디오 60% / 하단 DetectionPanel 40%)

---

## 6. Breakpoint & Detection

### 6.1 브레이크포인트

| 디바이스 | 너비 | 레이아웃 |
|---------|------|---------|
| 모바일 | < 768px | Mobile Layout (Bottom Nav) |
| 데스크톱 | ≥ 768px | Desktop Layout (Right Sidebar) |

### 6.2 감지 방법

```ts
// React state + resize listener
const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

useEffect(() => {
  const handler = () => setIsMobile(window.innerWidth < 768);
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
}, []);
```

---

## 7. Reused Components (재사용 컴포넌트 목록)

| 컴포넌트 | 파일 | 모바일 재사용 방식 |
|---------|------|-----------------|
| `CameraGrid` | `CameraGrid.tsx` | Cameras 탭 상단 영역 임베드 |
| `CameraList` | `CameraList.tsx` | Cameras 탭 하단 스크롤 목록 |
| `AlertPanel` | `AlertPanel.tsx` | Alerts 탭 전체화면 |
| `DetectionPanel` | `FullscreenCameraView.tsx` (export) | Detections 탭 전체화면 |
| `VideoAnalyticsTab` | `VideoAnalyticsTab.tsx` | Analytics 탭 전체화면 |
| `FullscreenCameraView` | `FullscreenCameraView.tsx` | 더블탭 시 오버레이 |
| `LayoutPicker` | `App.tsx` (inline) | ❌ 모바일에서 숨김 (간소화) |
| Settings Modal | `App.tsx` (inline) | 설정 아이콘 클릭 시 동일 모달 |

---

## 8. FullscreenCameraView — Mobile Orientation

모바일에서 FullscreenCameraView 오버레이는 세로 분할로 변경:

```
┌─────────────────────────────────────┐
│  Camera Name                    [✕] │  ← 헤더
├─────────────────────────────────────┤
│                                     │
│         CameraView (60%)            │  ← 비디오 영역
│                                     │
├─────────────────────────────────────┤
│  DetectionPanel (40%)               │  ← 감지 패널 (하단)
│  (스크롤 가능)                        │
└─────────────────────────────────────┘
```

- 데스크톱: 가로 분할 (비디오 좌 / DetectionPanel 우)
- 모바일: 세로 분할 (비디오 상 / DetectionPanel 하)

---

## 9. State Management

모바일과 데스크톱은 **동일한 Zustand store**를 공유.  
레이아웃 전환 시 상태 유지됨.

| Store | 공유 여부 | 비고 |
|-------|---------|------|
| `cameraStore` | ✅ 공유 | selectedId, cameras 목록 |
| `alertStore` | ✅ 공유 | 알림 목록, unread count |
| `crossCameraStore` | ✅ 공유 | Re-ID 이벤트 |
| `discoveryStore` | ✅ 공유 | ONVIF 검색 결과 |
| `webrtcConfigStore` | ✅ 공유 | WebRTC 설정 |
| `sidebarTab` (local) | ✅ 공유 | `SidebarTab` state, 모바일에서 Bottom Nav 탭으로 사용 |
| `sidebarWidth` (local) | ❌ 모바일 미사용 | 데스크톱 전용 |
| `isMobile` (local) | - | window resize 감지 |

---

## 10. Implementation Status

| 항목 | 상태 | 비고 |
|------|------|------|
| `isMobile` 감지 | ✅ | `App.tsx` — useEffect + resize listener |
| Mobile Header | ✅ | 레이아웃 피커 숨김, 컴팩트 헤더 |
| Bottom Navigation | ✅ | 5탭, 알림 뱃지 포함 |
| Cameras 탭 (모바일) | ✅ | CameraGrid + CameraList 세로 분할 |
| Alerts 탭 (모바일) | ✅ | AlertPanel 전체화면 재사용 |
| Zones 탭 (모바일) | ✅ | 기존 안내 JSX 재사용 |
| Detections 탭 (모바일) | ✅ | 드롭다운 + DetectionPanel 재사용 |
| Analytics 탭 (모바일) | ✅ | VideoAnalyticsTab 재사용 |
| Fullscreen Overlay (모바일) | ✅ | `flex-col` 세로 분할 (60/40) |
| Desktop 레이아웃 | ✅ | 기존 동작 유지 (≥ 768px) |
