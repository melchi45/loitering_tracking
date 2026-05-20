import re

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
# RFP_LTS2026_YouTube_RTSP_Ingest.md
# ============================================================
yt_replacements = [
    ('# RFP: YouTube → RTSP 수집 서비스', '# RFP: YouTube → RTSP Ingest Service'),
    ('**Status**: Phase-1 구현 기준 작성', '**Status**: Written based on Phase-1 implementation'),
    ('## 목차', '## Table of Contents'),
    ('1. [개요](#1-개요)', '1. [Overview](#1-overview)'),
    ('2. [시스템 아키텍처](#2-시스템-아키텍처)', '2. [System Architecture](#2-system-architecture)'),
    ('5. [상태 머신](#5-상태-머신)', '5. [State Machine](#5-state-machine)'),
    ('6. [반복 재생 (Repeat Playback)](#6-반복-재생-repeat-playback)', '6. [Repeat Playback](#6-repeat-playback)'),
    ('7. [오류 처리 및 자동 재시작](#7-오류-처리-및-자동-재시작)', '7. [Error Handling and Auto-restart](#7-error-handling-and-auto-restart)'),
    ('8. [구현 현황](#8-구현-현황)', '8. [Implementation Status](#8-implementation-status)'),
    ('## 1. 개요', '## 1. Overview'),
    ('### 1.1 목적\n\nLTS-2026 시스템은 물리적 IP 카메라 외에 **YouTube 영상(VOD/Live)** 을 가상 카메라 채널로 수집·재스트리밍하는 기능을 제공한다.  \n`yt-dlp` → `FFmpeg` → `MediaMTX RTSP` 파이프라인을 통해 YouTube 영상을 내부 RTSP URL로 노출하고, 기존 LTS 분석 파이프라인에 연결한다.',
     '### 1.1 Purpose\n\nThe LTS-2026 system provides functionality to ingest and re-stream **YouTube videos (VOD/Live)** as virtual camera channels in addition to physical IP cameras.  \nThe `yt-dlp` → `FFmpeg` → `MediaMTX RTSP` pipeline exposes YouTube videos as internal RTSP URLs and connects them to the existing LTS analysis pipeline.'),
    ('### 1.2 용어 정의', '### 1.2 Term Definitions'),
    ('| 용어 | 설명 |', '| Term | Description |'),
    ('| 가상 채널 | YouTube URL에서 파생된 내부 RTSP 스트림 (`rtsp://…/yt/<id>`) |',
     '| Virtual channel | Internal RTSP stream derived from YouTube URL (`rtsp://…/yt/<id>`) |'),
    ('| yt-dlp | YouTube 영상 스트림 URL 추출 + stdout 스트리밍 CLI 도구 |',
     '| yt-dlp | CLI tool for extracting YouTube stream URLs + stdout streaming |'),
    ('| FFmpeg | yt-dlp stdout을 RTSP MediaMTX로 재인코딩/전달하는 미디어 프로세서 |',
     '| FFmpeg | Media processor that re-encodes/forwards yt-dlp stdout to RTSP MediaMTX |'),
    ('| MediaMTX | 내부 RTSP 미디어 서버 |', '| MediaMTX | Internal RTSP media server |'),
    ('## 2. 시스템 아키텍처', '## 2. System Architecture'),
    ('    │  - 영상 트랜스코딩 (해상도·비트레이트 적용)', '    │  - Video transcoding (resolution & bitrate applied)'),
    ('LTS 분석 파이프라인 (Detection, Tracking, Analytics)', 'LTS Analysis Pipeline (Detection, Tracking, Analytics)'),
    ('### 3.1 StreamEntry 데이터 구조', '### 3.1 StreamEntry Data Structure'),
    ('| 필드 | 타입 | 설명 |', '| Field | Type | Description |'),
    ('| `id` | string | UUID 기반 스트림 ID (`yt-<uuid>`) |', '| `id` | string | UUID-based stream ID (`yt-<uuid>`) |'),
    ('| `name` | string | 채널 표시명 |', '| `name` | string | Channel display name |'),
    ('| `youtubeUrl` | string | 원본 YouTube 페이지 URL |', '| `youtubeUrl` | string | Original YouTube page URL |'),
    ('| `rtspUrl` | string | 내부 RTSP URL (`rtsp://…/yt/<id>`) |', '| `rtspUrl` | string | Internal RTSP URL (`rtsp://…/yt/<id>`) |'),
    ('| `resolution` | string | 목표 해상도 (`1080p` / `720p` / `480p`) |', '| `resolution` | string | Target resolution (`1080p` / `720p` / `480p`) |'),
    ('| `bitrate` | number | 비트레이트 (bps, DB 저장 단위) |', '| `bitrate` | number | Bitrate (bps, DB storage unit) |'),
    ('| `repeatPlayback` | boolean | 영상 종료 시 무한 반복 재생 여부 |', '| `repeatPlayback` | boolean | Whether to loop infinitely when video ends |'),
    ('| `status` | string | 현재 상태 (§5 상태 머신 참조) |', '| `status` | string | Current state (see §5 State Machine) |'),
    ('| `restartCount` | number | 현재 재시작 횟수 |', '| `restartCount` | number | Current restart count |'),
    ('| `createdAt` | string | ISO 타임스탬프 |', '| `createdAt` | string | ISO timestamp |'),
    ('### 3.2 주요 상수', '### 3.2 Key Constants'),
    ('| 상수 | 기본값 | 설명 |', '| Constant | Default | Description |'),
    ('| `MAX_RESTARTS` | `5` | 최대 자동 재시작 횟수 (repeatPlayback 비활성 시) |',
     '| `MAX_RESTARTS` | `5` | Maximum auto-restart attempts (when repeatPlayback is disabled) |'),
    ('| `RESTART_DELAY` | `5000ms` | 재시작 대기 시간 |', '| `RESTART_DELAY` | `5000ms` | Restart wait time |'),
    ('| `START_TIMEOUT` | `30000ms` | 스트림 시작 타임아웃 |', '| `START_TIMEOUT` | `30000ms` | Stream start timeout |'),
    ('### 4.1 엔드포인트 목록', '### 4.1 Endpoint List'),
    ('| Method | Path | 설명 |', '| Method | Path | Description |'),
    ('| `POST` | `/` | 새 가상 채널 생성 |', '| `POST` | `/` | Create new virtual channel |'),
    ('| `GET` | `/` | 전체 스트림 목록 조회 |', '| `GET` | `/` | Get all stream list |'),
    ('| `GET` | `/:id/status` | 특정 스트림 상태 폴링 |', '| `GET` | `/:id/status` | Poll specific stream status |'),
    ('| `PATCH` | `/:id` | 스트림 속성 업데이트 |', '| `PATCH` | `/:id` | Update stream properties |'),
    ('| `DELETE` | `/:id` | 스트림 종료 및 레코드 삭제 |', '| `DELETE` | `/:id` | Stop stream and delete record |'),
    ('| `POST` | `/:id/restart` | 오류 상태 스트림 수동 재시작 |', '| `POST` | `/:id/restart` | Manual restart of error-state stream |'),
    ('### 4.2 POST / — 스트림 생성', '### 4.2 POST / — Create Stream'),
    ('  "name":           "군중 테스트 영상",', '  "name":           "Crowd test video",'),
    ('| `youtubeUrl` | string | ✅ | — | YouTube 페이지 URL |', '| `youtubeUrl` | string | ✅ | — | YouTube page URL |'),
    ('| `name` | string | ✅ | — | 채널 표시명 |', '| `name` | string | ✅ | — | Channel display name |'),
    ('| `repeatPlayback` | boolean | ❌ | `false` | 영상 종료 시 무한 반복 재생 |',
     '| `repeatPlayback` | boolean | ❌ | `false` | Loop infinitely when video ends |'),
    ('    "name": "군중 테스트 영상",', '    "name": "Crowd test video",'),
    ('### 4.3 PATCH /:id — 스트림 업데이트', '### 4.3 PATCH /:id — Update Stream'),
    ('**Request Body** (모든 필드 선택적):', '**Request Body** (all fields optional):'),
    ('  "name":           "새 채널명",', '  "name":           "New channel name",'),
    ('> `youtubeUrl`, `resolution`, `bitrate` 변경 시 스트림 자동 재시작.  \n> `name`, `repeatPlayback` 변경 시 재시작 없이 즉시 적용.',
     '> Stream auto-restarts when `youtubeUrl`, `resolution`, or `bitrate` changes.  \n> `name` and `repeatPlayback` changes apply immediately without restart.'),
    ('### 4.4 에러 코드', '### 4.4 Error Codes'),
    ('| HTTP | 코드 | 설명 |', '| HTTP | Code | Description |'),
    ('| 422 | `INVALID_YOUTUBE_URL` | 유효하지 않은 YouTube URL |', '| 422 | `INVALID_YOUTUBE_URL` | Invalid YouTube URL |'),
    ('| 422 | `YT_DLP_FAILED` | yt-dlp 실행 실패 (비공개·삭제 영상 등) |', '| 422 | `YT_DLP_FAILED` | yt-dlp execution failed (private/deleted video, etc.) |'),
    ('| 503 | `FFMPEG_NOT_FOUND` | FFmpeg 바이너리 없음 |', '| 503 | `FFMPEG_NOT_FOUND` | FFmpeg binary not found |'),
    ('| 429 | `MAX_STREAMS_REACHED` | 스트림 최대 개수 초과 |', '| 429 | `MAX_STREAMS_REACHED` | Maximum stream count exceeded |'),
    ('| 504 | `STREAM_TIMEOUT` | 스트림 시작 타임아웃 |', '| 504 | `STREAM_TIMEOUT` | Stream start timeout |'),
    ('| 404 | `NOT_FOUND` | 스트림 ID 없음 |', '| 404 | `NOT_FOUND` | Stream ID not found |'),
    ('## 5. 상태 머신', '## 5. State Machine'),
    ('         │  starting   │──── START_TIMEOUT 초과 ──► error',
     '         │  starting   │──── START_TIMEOUT exceeded ──► error'),
    ('    MediaMTX publish 이벤트', '    MediaMTX publish event'),
    ('    FFmpeg close (code 0 = 정상 종료)', '    FFmpeg close (code 0 = normal end)'),
    ('    FFmpeg close (code ≠ 0 = 오류)', '    FFmpeg close (code ≠ 0 = error)'),
    ('         │ restarting  │──── MAX_RESTARTS 초과 (repeatPlayback=false) ──► error',
     '         │ restarting  │──── MAX_RESTARTS exceeded (repeatPlayback=false) ──► error'),
    ('          (starting 으로 복귀)', '          (returns to starting)'),
    ('> **repeatPlayback=true** 시: `live → restarting` 전환 시 `restartCount` 를 `0` 으로 리셋하여 MAX_RESTARTS 제한을 우회하고 무한 반복.',
     '> **When repeatPlayback=true**: On `live → restarting` transition, `restartCount` is reset to `0`, bypassing the MAX_RESTARTS limit for infinite loop.'),
    ('## 6. 반복 재생 (Repeat Playback)', '## 6. Repeat Playback'),
    ('### 6.1 기능 정의\n\nYouTube VOD 영상의 재생이 종료되면 파이프라인(yt-dlp → FFmpeg)이 자연스럽게 종료된다.  \n`repeatPlayback` 옵션을 활성화하면 영상이 종료될 때 자동으로 스트림을 재시작하여 **무한 반복 재생**을 구현한다.',
     '### 6.1 Feature Definition\n\nWhen YouTube VOD video playback ends, the pipeline (yt-dlp → FFmpeg) naturally terminates.  \nEnabling the `repeatPlayback` option automatically restarts the stream when the video ends, implementing **infinite loop playback**.'),
    ('### 6.2 재생 종료 감지\n\nFFmpeg 프로세스가 `exit code 0`, `signal null` 로 종료되면 **정상 종료(자연 종료)** 로 판단한다.',
     '### 6.2 Playback End Detection\n\nWhen the FFmpeg process exits with `exit code 0`, `signal null`, it is judged as a **normal end (natural termination)**.'),
    ('### 6.3 반복 재생 동작 흐름', '### 6.3 Repeat Playback Flow'),
    ('영상 정상 종료 (code=0)', 'Normal video end (code=0)'),
    ('      │       └── YES → entry.restartCount = 0  (카운터 리셋)',
     '      │       └── YES → entry.restartCount = 0  (counter reset)'),
    ('      │                → MAX_RESTARTS 체크 우회', '      │                → bypass MAX_RESTARTS check'),
    ('      │                → RESTART_DELAY 후 재시작', '      │                → restart after RESTART_DELAY'),
    ('              └── 일반 재시작 로직 (restartCount 증가, MAX_RESTARTS 체크)',
     '              └── normal restart logic (increment restartCount, check MAX_RESTARTS)'),
    ('### 6.4 오류 재시작과의 구분', '### 6.4 Distinction from Error Restart'),
    ('| 상황 | `isNaturalEnd` | `repeatPlayback` 효과 |', '| Situation | `isNaturalEnd` | `repeatPlayback` Effect |'),
    ('| 영상 정상 종료 (code=0) | `true` | 카운터 리셋 → 무한 반복 |', '| Normal video end (code=0) | `true` | Counter reset → infinite loop |'),
    ('| FFmpeg 오류 종료 (code≠0) | `false` | 일반 재시작 (MAX_RESTARTS 적용) |', '| FFmpeg error exit (code≠0) | `false` | Normal restart (MAX_RESTARTS applies) |'),
    ('| MediaMTX unpublish | `false` | 일반 재시작 (MAX_RESTARTS 적용) |', '| MediaMTX unpublish | `false` | Normal restart (MAX_RESTARTS applies) |'),
    ('> 오류로 인한 재시작은 `repeatPlayback=true` 여도 `MAX_RESTARTS` 제한이 유지된다.  \n> 영상이 정상 종료된 경우에만 무한 반복 동작.',
     '> Restarts due to error maintain the `MAX_RESTARTS` limit even when `repeatPlayback=true`.  \n> Infinite loop only applies when the video ends normally.'),
    ('### 6.5 UI 명세', '### 6.5 UI Specification'),
    ('#### 6.5.1 추가 Modal (YouTube 탭)', '#### 6.5.1 Add Modal (YouTube tab)'),
    ('- 폼 최하단에 체크박스 표시', '- Checkbox displayed at the bottom of the form'),
    ('- 레이블: `반복 재생 — 영상 종료 시 자동 재시작`', '- Label: `Repeat Playback — Auto-restart when video ends`'),
    ('- 기본값: `false` (미체크)', '- Default: `false` (unchecked)'),
    ('- `POST /api/youtube-streams` body에 `repeatPlayback` 포함', '- `repeatPlayback` included in `POST /api/youtube-streams` body'),
    ('#### 6.5.2 편집 Modal (YouTube 채널)', '#### 6.5.2 Edit Modal (YouTube channel)'),
    ('- Resolution/Bitrate 섹션 이후, 내부 RTSP URL 이전에 체크박스 표시',
     '- Checkbox displayed after Resolution/Bitrate section, before internal RTSP URL'),
    ('- 레이블: `반복 재생 — 영상 종료 시 자동 재시작`', '- Label: `Repeat Playback — Auto-restart when video ends`'),
    ('- 초기값: 서버에서 반환된 `camera.repeatPlayback`', '- Initial value: `camera.repeatPlayback` returned from server'),
    ('- `PATCH /api/youtube-streams/{id}` body에 `repeatPlayback` 포함', '- `repeatPlayback` included in `PATCH /api/youtube-streams/{id}` body'),
    ('- `repeatPlayback` 변경은 스트림 재시작 없이 즉시 적용', '- `repeatPlayback` change applies immediately without stream restart'),
    ('## 7. 오류 처리 및 자동 재시작', '## 7. Error Handling and Auto-restart'),
    ('### 7.1 일반 재시작 로직', '### 7.1 Normal Restart Logic'),
    ('| 트리거 | 설명 |', '| Trigger | Description |'),
    ('| FFmpeg 프로세스 종료 (code≠0) | 스트림 오류 — 재시작 시도 |', '| FFmpeg process exit (code≠0) | Stream error — attempt restart |'),
    ('| FFmpeg 정상 종료 (code=0) | 영상 종료 — `repeatPlayback` 여부로 분기 |',
     '| FFmpeg normal exit (code=0) | Video end — branch on `repeatPlayback` |'),
    ('| MediaMTX unpublish 이벤트 | RTSP 경로 사라짐 — 재시작 시도 |',
     '| MediaMTX unpublish event | RTSP path disappeared — attempt restart |'),
    ('### 7.2 상태 전이 조건', '### 7.2 State Transition Conditions'),
    ('| 상태 | 설명 |', '| State | Description |'),
    ('| `starting` | yt-dlp + FFmpeg 프로세스 시작 대기 |', '| `starting` | Waiting for yt-dlp + FFmpeg process start |'),
    ('| `live` | MediaMTX publish 확인, 스트림 활성 |', '| `live` | MediaMTX publish confirmed, stream active |'),
    ('| `restarting` | RESTART_DELAY 대기 중 |', '| `restarting` | Waiting for RESTART_DELAY |'),
    ('| `error` | MAX_RESTARTS 초과 (수동 재시작 필요) |', '| `error` | MAX_RESTARTS exceeded (manual restart required) |'),
    ('| `stopping` | stopStream() 호출, 프로세스 종료 중 |', '| `stopping` | stopStream() called, process terminating |'),
    ('| `removed` | 레코드 삭제 완료 |', '| `removed` | Record deletion complete |'),
    ('## 8. 구현 현황', '## 8. Implementation Status'),
    ('| 항목 | 상태 | 비고 |', '| Item | Status | Notes |'),
    ('| `YouTubeStreamService` 코어 로직 | ✅ 완료 | `server/src/services/youtubeStreamService.js` |',
     '| `YouTubeStreamService` core logic | ✅ Done | `server/src/services/youtubeStreamService.js` |'),
    ('| REST API 엔드포인트 | ✅ 완료 | `server/src/api/youtubeStreams.js` |',
     '| REST API endpoints | ✅ Done | `server/src/api/youtubeStreams.js` |'),
    ('| 반복 재생 (`repeatPlayback`) | ✅ 완료 | `_scheduleRestart(entry, isNaturalEnd)` |',
     '| Repeat Playback (`repeatPlayback`) | ✅ Done | `_scheduleRestart(entry, isNaturalEnd)` |'),
    ('| DB 저장 (`cameras` 테이블) | ✅ 완료 | `repeatPlayback` 컬럼 |',
     '| DB storage (`cameras` table) | ✅ Done | `repeatPlayback` column |'),
    ('| 클라이언트 추가 Modal 체크박스 | ✅ 완료 | `client/src/components/CameraList.tsx` |',
     '| Client add Modal checkbox | ✅ Done | `client/src/components/CameraList.tsx` |'),
    ('| 클라이언트 편집 Modal 체크박스 | ✅ 완료 | `client/src/components/CameraEditModal.tsx` |',
     '| Client edit Modal checkbox | ✅ Done | `client/src/components/CameraEditModal.tsx` |'),
    ('| `Camera` 타입 확장 | ✅ 완료 | `client/src/types/index.ts` |',
     '| `Camera` type extension | ✅ Done | `client/src/types/index.ts` |'),
]

r1 = translate_file(f'{BASE}/RFP_LTS2026_YouTube_RTSP_Ingest.md', yt_replacements)
print(f"RFP_LTS2026_YouTube_RTSP_Ingest.md: {'updated' if r1 else 'no changes'}")

# ============================================================
# Small file fixes
# ============================================================

# RFP_Dashboard_Detection_Display.md
dd_replacements = [
    ('"미설치" label', '"Not installed" label'),
]
r2 = translate_file(f'{BASE}/RFP_Dashboard_Detection_Display.md', dd_replacements)
print(f"RFP_Dashboard_Detection_Display.md: {'updated' if r2 else 'no changes'}")

# RFP_YouTube_RTSP_Ingest.md
yt2_replacements = [
    ('Toast error: "영상을 가져올 수 없습니다. 비공개 또는 삭제된 영상일 수 있습니다."',
     'Toast error: "Unable to retrieve video. It may be private or deleted."'),
    ('Toast error: "스트림 시작 시간이 초과되었습니다. 다시 시도하세요."',
     'Toast error: "Stream start timed out. Please try again."'),
    ('red error banner with a **재시작 (Restart)** button', 'red error banner with a **Restart** button'),
]
r3 = translate_file(f'{BASE}/RFP_YouTube_RTSP_Ingest.md', yt2_replacements)
print(f"RFP_YouTube_RTSP_Ingest.md: {'updated' if r3 else 'no changes'}")

# RFP_LTS2026_WebRTC_Media_Gateway.md
webrtc_replacements = [
    ('"WebRTC 연결 중…" indefinitely', '"WebRTC Connecting…" indefinitely'),
    ('"WebRTC 연결 실패" after 30 seconds', '"WebRTC Connection Failed" after 30 seconds'),
    ('### 15.1 "WebRTC 연결 중…" — Connection Stuck in Connecting State',
     '### 15.1 "WebRTC Connecting…" — Connection Stuck in Connecting State'),
    ('### 15.2 "WebRTC 연결 실패" — Connection Failed',
     '### 15.2 "WebRTC Connection Failed" — Connection Failed'),
    ('Click "재연결" to recreate the session', 'Click "Reconnect" to recreate the session'),
]
r4 = translate_file(f'{BASE}/RFP_LTS2026_WebRTC_Media_Gateway.md', webrtc_replacements)
print(f"RFP_LTS2026_WebRTC_Media_Gateway.md: {'updated' if r4 else 'no changes'}")

# RFP_AI_Mask_Detection.md
mask_replacements = [
    ('| `available` | Model file present, not yet loaded (loads on first camera start) | 대기 |',
     '| `available` | Model file present, not yet loaded (loads on first camera start) | Standby |'),
    ('| `loaded`    | Model actively running in memory | 활성 |',
     '| `loaded`    | Model actively running in memory | Active |'),
    ('| `failed`    | Model file found but loading failed (OOM, corrupt file) | 로드실패 |',
     '| `failed`    | Model file found but loading failed (OOM, corrupt file) | Load failed |'),
    ('| `missing`   | Model file not on disk — run `npm run download-models` | 미설치 |',
     '| `missing`   | Model file not on disk — run `npm run download-models` | Not installed |'),
]
r5 = translate_file(f'{BASE}/RFP_AI_Mask_Detection.md', mask_replacements)
print(f"RFP_AI_Mask_Detection.md: {'updated' if r5 else 'no changes'}")

# RFP_AI_Hat_Detection.md
hat_replacements = [
    ('| 0 | `no_hat` | 맨머리 | No head covering | — |', '| 0 | `no_hat` | Bare head | No head covering | — |'),
    ('| 1 | `baseball_cap` | 야구모자 | Forward, backward, sideways cap | No |',
     '| 1 | `baseball_cap` | Baseball cap | Forward, backward, sideways cap | No |'),
    ('| 2 | `beanie` | 비니 | Knit beanie/winter hat | No |', '| 2 | `beanie` | Beanie | Knit beanie/winter hat | No |'),
    ('| 3 | `helmet_hard` | 안전모 | Construction/industrial hardhat | **Safety item** |',
     '| 3 | `helmet_hard` | Safety helmet | Construction/industrial hardhat | **Safety item** |'),
    ('| 4 | `helmet_bike` | 자전거 헬멧 | Bicycle/motorcycle helmet | **Safety item** |',
     '| 4 | `helmet_bike` | Bike helmet | Bicycle/motorcycle helmet | **Safety item** |'),
    ('| 5 | `hood_up` | 후드 착용 | Hoodie with hood raised | Suspicious |',
     '| 5 | `hood_up` | Hood up | Hoodie with hood raised | Suspicious |'),
    ('| 6 | `hat_wide` | 챙 넓은 모자 | Sun hat, fedora, cowboy hat | No |',
     '| 6 | `hat_wide` | Wide-brim hat | Sun hat, fedora, cowboy hat | No |'),
    ('| 7 | `hair_net` | 위생모 | Hygiene hair net/cap | **Safety item** |',
     '| 7 | `hair_net` | Hair net | Hygiene hair net/cap | **Safety item** |'),
    ('| 8 | `beret` | 베레모 | Military/artistic beret |', '| 8 | `beret` | Beret | Military/artistic beret |'),
    ('| 9 | `turban` | 터번 | Religious/cultural head covering |', '| 9 | `turban` | Turban | Religious/cultural head covering |'),
    ('| 10 | `face_shield_hat` | 안면보호 헬멧 | Full face shield (welding, grinding) |',
     '| 10 | `face_shield_hat` | Face shield helmet | Full face shield (welding, grinding) |'),
    ('| 11 | `hairband` | 헤어밴드 | Non-covering head accessory |', '| 11 | `hairband` | Hairband | Non-covering head accessory |'),
    ('| 12 | `police_cap` | 경찰 모자 | Law enforcement uniform cap |', '| 12 | `police_cap` | Police cap | Law enforcement uniform cap |'),
    ('| 13 | `chef_hat` | 쉐프 모자 | Food service/kitchen hat |', '| 13 | `chef_hat` | Chef hat | Food service/kitchen hat |'),
]
r6 = translate_file(f'{BASE}/RFP_AI_Hat_Detection.md', hat_replacements)
print(f"RFP_AI_Hat_Detection.md: {'updated' if r6 else 'no changes'}")

print("Phase 2 part 4 complete.")
