---
**Document:** Design_FullscreenPanel_Splitbar  
**Version:** 1.0  
**Status:** Done  
**Date:** 2026-06-23  
**Implementation:** `client/src/components/FullscreenCameraView.tsx`  
---

# Design — Fullscreen Camera View Bottom Panel Splitbar

## 1. 개요

전체화면 카메라 뷰(`FullscreenCameraView`)의 하단 탭 패널(Events / ONVIF / Detections)과 비디오 영역 사이에 드래그 가능한 **Splitbar**를 추가하여 사용자가 패널 높이를 자유롭게 조정할 수 있도록 한다.

조정된 높이는 `localStorage`에 저장되어 페이지 새로고침 후에도 유지된다.

---

## 2. 레이아웃 구조

```
FullscreenCameraView (fixed inset-0, flex-row on desktop)
│
├─ Video Column (flex-1)
│   ├─ Header bar          (flex-shrink-0)
│   ├─ Video stream        (flex-1)
│   ├─ Splitbar            (flex-shrink-0, h-2, cursor-row-resize)  ← NEW
│   └─ Bottom tab panel    (flex-shrink-0, height = panelHeight px) ← 동적 높이
│
└─ Right Detection Panel   (width: 288px)
```

---

## 3. 상태 관리

### 3.1 상수

| 상수 | 값 | 설명 |
|---|---|---|
| `PANEL_MIN_H` | `60` | 패널 최소 높이 (px) — 탭 바 표시 최소치 |
| `PANEL_MAX_H` | `600` | 패널 최대 높이 (px) |
| `PANEL_STORAGE_KEY` | `'lts_fullscreen_panel_height'` | localStorage 키 |

### 3.2 상태

```typescript
const [panelHeight, setPanelHeight] = useState<number>(() => {
  const saved = parseInt(localStorage.getItem(PANEL_STORAGE_KEY) ?? '', 10);
  return isNaN(saved) ? 200 : Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, saved));
});
```

- 초기값: localStorage에 저장된 값 → 없거나 유효하지 않으면 `200px`
- 범위 클램프: `[PANEL_MIN_H, PANEL_MAX_H]`

---

## 4. Splitbar 동작

### 4.1 마우스 드래그 (`handleSplitbarMouseDown`)

```
mousedown on splitbar
  → capture startY (e.clientY), startH (panelHeight)
  → attach document.mousemove → setPanelHeight(clamp(startH + (startY - ev.clientY)))
  → attach document.mouseup   → localStorage.setItem + detach listeners
```

- 위로 드래그 → 패널 높이 증가
- 아래로 드래그 → 패널 높이 감소
- `mouseup` 시 최종 값을 localStorage에 저장

### 4.2 터치 드래그 (`handleSplitbarTouchStart`)

```
touchstart on splitbar
  → capture startY (touches[0].clientY), startH (panelHeight)
  → attach document.touchmove (passive: false) → setPanelHeight(...)
  → attach document.touchend → localStorage.setItem + detach listeners
```

- `passive: false`: `ev.preventDefault()` 호출로 스크롤 충돌 방지

### 4.3 이벤트 리스너 등록 위치

이벤트 리스너를 `document`에 등록하는 이유: 마우스/터치가 빠르게 이동해 splitbar 요소 밖으로 나가도 드래그가 끊기지 않도록 한다.

---

## 5. Splitbar UI 사양

```jsx
<div
  className="flex-shrink-0 flex items-center justify-center h-2
             bg-gray-800/80 hover:bg-indigo-900/60 active:bg-indigo-800/70
             cursor-row-resize group
             border-t border-b border-gray-700/60
             transition-colors select-none"
  onMouseDown={handleSplitbarMouseDown}
  onTouchStart={handleSplitbarTouchStart}
  title="Drag to resize panel"
>
  <div className="w-10 h-0.5 rounded-full bg-gray-600 group-hover:bg-indigo-400 transition-colors" />
</div>
```

| 속성 | 값 |
|---|---|
| 높이 | `h-2` (8px) |
| 커서 | `cursor-row-resize` |
| 호버 색상 | 인디고 tint (`indigo-900/60`) |
| 핸들 인디케이터 | 중앙 가로 선 (w-10 h-0.5, 호버 시 indigo-400) |
| 텍스트 선택 방지 | `select-none` |

---

## 6. localStorage 영속성

| 동작 | 저장 타이밍 |
|---|---|
| 마우스 드래그 | `mouseup` 이벤트 — 드래그 완료 시 1회 |
| 터치 드래그 | `touchend` 이벤트 — 손 뗄 때 1회 |
| 초기 로드 | `useState` lazy initializer — 저장값 복원 |

저장된 값은 컴포넌트 마운트마다 복원되므로 탭 전환, 페이지 새로고침 후에도 유지된다.

---

## 7. 이전 동작과의 차이

| 항목 | Before | After |
|---|---|---|
| 패널 높이 결정 | 탭에 따른 고정값 (160/200/300px) | 사용자 드래그 → `panelHeight` state |
| 높이 영속성 | 없음 (탭 전환 시 초기화) | localStorage에 저장 |
| Splitbar | 없음 | 8px 드래그 핸들 |
| 모바일 지원 | — | `touchstart/move/end` 이벤트 처리 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-23 | 초기 작성 — Splitbar 드래그 리사이즈, localStorage 영속성 설계 |
