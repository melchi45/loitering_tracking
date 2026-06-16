# Design: Admin Dashboard

**Version:** 1.0
**Status:** Implemented
**Related:** [Design_ONVIF_Timeline.md](Design_ONVIF_Timeline.md) · [SRS_User_Authentication.md](../srs/SRS_User_Authentication.md)

---

## 1. Overview

Admin Dashboard는 `admin` 역할 사용자 전용 관리 화면입니다.
Dashboard 화면에서 사용자 프로필 드롭다운 → "User Management" 메뉴를 통해 진입하며,
단일 파일(`AdminUsersPage.tsx`)이 좌측 사이드바 내비게이션과 섹션별 콘텐츠를 포함합니다.

**접근 제어:** `App.tsx`에서 `auth.page === 'admin'` 일 때 렌더링. `role !== 'admin'`이면 `AccessDeniedPage`로 차단.

---

## 2. 레이아웃 구조

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Admin Dashboard                                    [Admin]    │  ← Header (fixed)
├──────────────────┬──────────────────────────────────────────────┤
│  👥 Users        │                                              │
│     Manage...    │   Section content (scrollable)               │
│                  │                                              │
│  📡 ONVIF        │                                              │
│     Event type   │                                              │
│                  │                                              │
│  📋 Audit Log    │                                              │
│     Activity     │                                              │
└──────────────────┴──────────────────────────────────────────────┘
  ↑ Sidebar (w-52, fixed)
```

| 영역 | 설명 |
|------|------|
| Header | 뒤로가기(Dashboard), 제목, [Admin] 배지, Dashboard 링크 |
| Sidebar | `AdminSection` 상태에 따라 활성 탭 강조 (`bg-blue-600/20 border-blue-600/30`) |
| Content | 섹션별 독립 컴포넌트 (`UsersSection`, `OnvifSection`, `AuditSection`) |

---

## 3. 내비게이션 섹션

```typescript
type AdminSection = 'users' | 'onvif' | 'audit';
```

| id | 아이콘 | 제목 | 설명 |
|----|--------|------|------|
| `users` | 👥 | Users | Manage user accounts & roles |
| `onvif` | 📡 | ONVIF | Event type registry |
| `audit` | 📋 | Audit Log | Activity history |

---

## 4. 섹션별 설계

### 4.1 Users 섹션 (`UsersSection`)

**목적:** 사용자 계정 승인·거절·역할 변경·삭제

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/users?status=&search=` | 사용자 목록 조회 |
| PATCH | `/admin/users/:id` | 상태·역할 변경 (`action`: approve/reject/revoke/reactivate) |
| DELETE | `/admin/users/:id` | 사용자 삭제 |

**상태:**
| State | Type | Description |
|-------|------|-------------|
| `users` | `User[]` | 로드된 사용자 목록 |
| `filter` | `StatusFilter` | `all`/`pending`/`active`/`rejected`/`revoked` |
| `search` | string | 이메일·이름·조직 검색어 |
| `loading` | boolean | 데이터 로딩 중 |
| `actionId` | string\|null | 액션 진행 중인 사용자 ID (버튼 disabled 처리) |

**Actions per user status:**
- `pending` → Approve / Reject 버튼
- `active` → Role select (admin/operator/viewer) + Revoke 버튼
- `rejected` / `revoked` → Reactivate 버튼
- 모든 상태 → Delete 버튼 (red, 확인 다이얼로그)

### 4.2 ONVIF 섹션 (`OnvifSection`)

**목적:** ONVIF 이벤트 타입 전역 레지스트리 조회 및 초기화

**참조:** [Design_ONVIF_Timeline.md §3.4](Design_ONVIF_Timeline.md)

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/onvif-event-types` | 등록된 모든 타입 조회 |
| DELETE | `/api/onvif-event-types` | 레지스트리 전체 초기화 |

**요약 카드:**

| 카드 | 색상 | 값 |
|------|------|----|
| Registered Types | blue | `types.length` |
| Critical | red | `types.filter(t => t.severity === 'critical').length` |
| Warning | yellow | `types.filter(t => t.severity === 'warning').length` |

**테이블 컬럼:** Type Key · Label · Severity · Topic URI · First Seen

**Zustand 연동:** `useOnvifEventStore()` → `types`, `setTypes`, `clearTypes`

### 4.3 Audit Log 섹션 (`AuditSection`)

**목적:** 시스템 활동 이력 조회 (최근 200건)

**API:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/audit?limit=200` | 감사 로그 조회 |

**기능:**
- 키워드 필터: `event`, `userEmail`, `detail` 필드에 대한 클라이언트 사이드 필터링
- ↺ Refresh 버튼으로 수동 재조회

**테이블 컬럼:** Time · User · Event (monospace) · Detail

---

## 5. 공유 서브컴포넌트

같은 파일 내에 재사용 컴포넌트로 정의합니다.

| 컴포넌트 | Props | 역할 |
|---------|-------|------|
| `SectionHeader` | `title`, `subtitle` | 섹션 제목 + 부제목 |
| `StatCard` | `label`, `value`, `color` | 숫자 요약 카드 (blue/red/yellow) |
| `ErrorBar` | `msg` | 빨간 에러 배너 |
| `EmptyState` | `msg` | 빈 상태 텍스트 (py-16 centered) |

---

## 6. API 요약

> Admin 섹션의 모든 API는 `apiFetch()` 래퍼를 통해 호출됩니다.
> 래퍼는 `Authorization: Bearer <accessToken>` 헤더와 `credentials: 'include'`를 자동 첨부합니다.

```typescript
async function apiFetch(path: string, opts: RequestInit = {}): Promise<unknown>
```

---

## 7. 키보드 단축키

| 키 | 동작 |
|----|------|
| `Escape` | 메인 Dashboard로 이동 (`navigateTo('dashboard')`) |

`AdminUsersPage` 마운트 시 `window.addEventListener('keydown', ...)` 등록, 언마운트 시 제거.

---

## 8. App.tsx 연동

```typescript
// App.tsx 진입 조건
if (auth.page === 'admin') return <AdminUsersPage />;
if (auth.user?.role !== 'admin') return <AccessDeniedPage />;

// 프로필 드롭다운 진입점 (combined 모드에서만 표시)
User Management → auth.navigateTo('admin')  // admin 역할 전용
```

---

## 9. 파일 구조

```
client/src/pages/admin/
└── AdminUsersPage.tsx     — Admin Dashboard 전체 (단일 파일)
    ├── export default AdminUsersPage  — 진입점 (App.tsx 참조)
    ├── UsersSection                   — 사용자 관리
    ├── OnvifSection                   — ONVIF 타입 레지스트리
    ├── AuditSection                   — 감사 로그
    ├── SectionHeader                  — 공유 헤더 컴포넌트
    ├── StatCard                       — 공유 요약 카드
    ├── ErrorBar                       — 공유 에러 배너
    └── EmptyState                     — 공유 빈 상태
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — Admin Dashboard 좌측 사이드바 구조, Users/ONVIF/Audit 3개 섹션 설계 문서화 |
| 1.1 | 2026-06-16 | Escape 키 → 메인 Dashboard 이동 단축키 추가 |
