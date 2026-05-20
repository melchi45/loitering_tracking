def translate_file(filepath, replacements):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    original = content
    for korean, english in replacements:
        content = content.replace(korean, english)
    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    return False

BASE = '/home/youngho/workspace/loitering_tracking'

# ============================================================
# README.md — lines outside code blocks only
# ============================================================
readme_replacements = [
    ('### 1.5 ICE Candidate 테스트', '### 1.5 ICE Candidate Test'),
    ('WebRTC 연결이 어떤 경로(LAN 직접 / STUN / TURN)를 사용하는지 확인하는 방법입니다.',
     'This describes how to check which path (LAN direct / STUN / TURN) the WebRTC connection is using.'),
    ('#### 방법 0 — 자동화 스크립트 (한 번에 전체 점검)',
     '#### Method 0 — Automated Script (full check at once)'),
    ('브라우저를 자동으로 띄우고 ICE 연결 경로·트래픽·이벤트 로그를 출력합니다.',
     'Automatically launches a browser and outputs ICE connection path, traffic, and event logs.'),
    ('**동작 순서:**', '**Operation sequence:**'),
    ('**실패 시 스크린샷:** `/tmp/lts-ice-test-fail.png`',
     '**Screenshot on failure:** `/tmp/lts-ice-test-fail.png`'),
    ('**성공 시 스크린샷:** `/tmp/lts-ice-test-ok.png`',
     '**Screenshot on success:** `/tmp/lts-ice-test-ok.png`'),
]
r1 = translate_file(f'{BASE}/README.md', readme_replacements)
print(f"README.md: {'updated' if r1 else 'no changes'}")

# ============================================================
# RFP_Dashboard_Layout.md
# ============================================================
dl_replacements = [
    ('| 폼 submit 방지 | `onSubmit={e => e.preventDefault()}` |',
     '| Form submit prevention | `onSubmit={e => e.preventDefault()}` |'),
]
r2 = translate_file(f'{BASE}/RFP_Dashboard_Layout.md', dl_replacements)
print(f"RFP_Dashboard_Layout.md: {'updated' if r2 else 'no changes'}")

# ============================================================
# RFP_Dashboard_Sidebar_Alerts_Zones.md
# ============================================================
az_replacements = [
    ('| 텍스트 | `Ack` |', '| Text | `Ack` |'),
    ('| 요소 | 설명 |', '| Element | Description |'),
    ('| 필드 | 타입 | 동작 |', '| Field | Type | Behavior |'),
    ('| 요소 | 스타일 |', '| Element | Style |'),
    ('| 이벤트 | 동작 |', '| Event | Behavior |'),
    ('| 항목 | 조건 | 동작 |', '| Item | Condition | Behavior |'),
    ('### 11.1 엔드포인트 목록', '### 11.1 Endpoint List'),
    ('| 이벤트 | 방향 | 처리 |', '| Event | Direction | Handler |'),
    ('| 처리 | 설명 |', '| Handler | Description |'),
    ('| Clear All 버튼 | ✅ 완료 |', '| Clear All button | ✅ Done |'),
    ('| Saved Zones 목록 | ✅ 완료 |', '| Saved Zones list | ✅ Done |'),
    ('| 항목 | 우선순위 | 비고 |', '| Item | Priority | Notes |'),
]
r3 = translate_file(f'{BASE}/RFP_Dashboard_Sidebar_Alerts_Zones.md', az_replacements)
print(f"RFP_Dashboard_Sidebar_Alerts_Zones.md: {'updated' if r3 else 'no changes'}")

# ============================================================
# RFP_Dashboard_Sidebar_Cameras.md
# ============================================================
cam_replacements = [
    ('- 폰트 크기: `text-[11px] font-semibold uppercase`',
     '- Font size: `text-[11px] font-semibold uppercase`'),
    ('- 색상: `text-xs text-gray-500 text-center mt-6`',
     '- Color: `text-xs text-gray-500 text-center mt-6`'),
    ('| 요소 | 설명 |', '| Element | Description |'),
    ('- CSS: `text-[10px] text-gray-400 truncate` (너비 초과 시 말줄임표 처리)',
     '- CSS: `text-[10px] text-gray-400 truncate` (ellipsis when width exceeded)'),
    ('| 이벤트 | 동작 |', '| Event | Behavior |'),
    ('| 상태 | 표시 |', '| State | Display |'),
    ('| **SUNAPI 뱃지** | `bg-green-900 text-green-400` |', '| **SUNAPI badge** | `bg-green-900 text-green-400` |'),
    ('| **ONVIF 뱃지** | `bg-purple-900 text-purple-300` |', '| **ONVIF badge** | `bg-purple-900 text-purple-300` |'),
    ('| 뱃지 | 조건 |', '| Badge | Condition |'),
    ('| 타입 | 표시 | 설명 |', '| Type | Display | Description |'),
    ('**제출 API**: `POST /api/cameras`', '**Submit API**: `POST /api/cameras`'),
    ('| 조건 | 에러 메시지 |', '| Condition | Error message |'),
    ('**제출 API**: `POST /api/youtube-streams`', '**Submit API**: `POST /api/youtube-streams`'),
    ('**응답**: 백그라운드에서 `yt-dlp` + FFmpeg 실행 → 폴링으로 상태 확인',
     '**Response**: Runs `yt-dlp` + FFmpeg in the background → polls for status'),
    ('| 필드 | 타입 | 설명 |', '| Field | Type | Description |'),
    ('| 버튼 | API | 설명 |', '| Button | API | Description |'),
    ('**제출 API**: `PATCH /api/youtube-streams/{id}`', '**Submit API**: `PATCH /api/youtube-streams/{id}`'),
    ('| 항목 | 설명 |', '| Item | Description |'),
    ('| HTTP / HTTPS 포트 | `HttpPort`, `HttpsPort` |', '| HTTP / HTTPS Port | `HttpPort`, `HttpsPort` |'),
    ('| 버튼 | 동작 |', '| Button | Behavior |'),
    ('| 액션 | 설명 |', '| Action | Description |'),
    ('| SUNAPI/ONVIF 뱃지 | ✅ 완료 |', '| SUNAPI/ONVIF badge | ✅ Done |'),
    ('| 항목 | 우선순위 | 비고 |', '| Item | Priority | Notes |'),
]
r4 = translate_file(f'{BASE}/RFP_Dashboard_Sidebar_Cameras.md', cam_replacements)
print(f"RFP_Dashboard_Sidebar_Cameras.md: {'updated' if r4 else 'no changes'}")

# ============================================================
# RFP_LTS2026_YouTube_RTSP_Ingest.md — remaining 3 lines
# ============================================================
yt_fix = [
    ('| 필드 | 타입 | 필수 | 기본값 | 설명 |', '| Field | Type | Required | Default | Description |'),
    ('         (starting 으로 복귀)', '         (returns to starting)'),
    ('| Normal video end (code=0) | `true` | 카운터 리셋 → 무한 반복 |',
     '| Normal video end (code=0) | `true` | Counter reset → infinite loop |'),
]
r5 = translate_file(f'{BASE}/RFP_LTS2026_YouTube_RTSP_Ingest.md', yt_fix)
print(f"RFP_LTS2026_YouTube_RTSP_Ingest.md: {'updated' if r5 else 'no changes'}")

# ============================================================
# RFP_LTS2026_WebRTC_Media_Gateway.md — remaining 1 line
# ============================================================
webrtc_fix = [
    ('click "재연결" button', 'click "Reconnect" button'),
]
r6 = translate_file(f'{BASE}/RFP_LTS2026_WebRTC_Media_Gateway.md', webrtc_fix)
print(f"RFP_LTS2026_WebRTC_Media_Gateway.md: {'updated' if r6 else 'no changes'}")

# ============================================================
# RFP_AI_Cloth_Analysis.md — table rows outside code blocks
# ============================================================
cloth_fix = [
    ('**Selected** — 40+ 속성 포함 (의류유형+색상+모자+가방)',
     '**Selected** — 40+ attributes (clothing type+color+hat+bag)'),
    ('| UPAR Dataset (GH) | https://github.com/speckean/upar_dataset | 4개 데이터셋 통합 40속성 |',
     '| UPAR Dataset (GH) | https://github.com/speckean/upar_dataset | 40 attributes unified from 4 datasets |'),
    ('| EventPAR | https://arxiv.org/abs/2408.09720 | RGB+Event 100K 샘플 |',
     '| EventPAR | https://arxiv.org/abs/2408.09720 | RGB+Event 100K samples |'),
]
r7 = translate_file(f'{BASE}/RFP_AI_Cloth_Analysis.md', cloth_fix)
print(f"RFP_AI_Cloth_Analysis.md: {'updated' if r7 else 'no changes'}")

# ============================================================
# RFP_AI_Color_Analysis.md — lines outside code blocks
# ============================================================
color_fix = [
    ('#### Phase-1: RGB 색상 추출 (즉시 사용 가능, 모델 불필요)',
     '#### Phase-1: RGB Color Extraction (immediately usable, no model required)'),
    ('11색 분류표:', '11-color classification table:'),
    ('#### Phase-2: PAR 모델 (ML 기반 다중 속성)',
     '#### Phase-2: PAR Model (ML-based multi-attribute)'),
    ('**Selected** — 40+ 속성 (색상+의류+모자+가방)',
     '**Selected** — 40+ attributes (color+clothing+hat+bag)'),
    ('| UPAR Dataset (GH) | https://github.com/speckean/upar_dataset | PA100K+PETA+RAP2 통합 40속성 |',
     '| UPAR Dataset (GH) | https://github.com/speckean/upar_dataset | PA100K+PETA+RAP2 unified 40 attributes |'),
]
r8 = translate_file(f'{BASE}/RFP_AI_Color_Analysis.md', color_fix)
print(f"RFP_AI_Color_Analysis.md: {'updated' if r8 else 'no changes'}")

print("\nAll done!")
