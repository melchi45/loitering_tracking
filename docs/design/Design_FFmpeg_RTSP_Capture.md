# DESIGN DOCUMENT
# FFmpeg RTSP Capture — 버전 호환성 및 파이프라인 설계

| | |
|---|---|
| **Document ID** | DESIGN-LTS-FFMPEG-001 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-04 |
| **Ops Guide** | [FFmpeg_Installation_Compatibility.md](../ops/FFmpeg_Installation_Compatibility.md) |
| **Test Cases** | [TC_FFmpeg_RTSP_Capture.md](../tc/TC_FFmpeg_RTSP_Capture.md) |

---

## Table of Contents
1. [목적 및 범위](#1-목적-및-범위)
2. [아키텍처 개요](#2-아키텍처-개요)
3. [ffmpeg 버전 감지 설계](#3-ffmpeg-버전-감지-설계)
4. [RTSP 캡처 파이프라인](#4-rtsp-캡처-파이프라인)
5. [ffmpeg 버전별 CLI 플래그 차이](#5-ffmpeg-버전별-cli-플래그-차이)
6. [오류 처리 및 재연결](#6-오류-처리-및-재연결)
7. [YouTube → RTSP 파이프라인에서의 ffmpeg](#7-youtube--rtsp-파이프라인에서의-ffmpeg)
8. [환경변수 참조](#8-환경변수-참조)
9. [향후 고려사항](#9-향후-고려사항)

---

## 1. 목적 및 범위

이 문서는 LTS-2026이 RTSP 카메라 스트림 수집에 ffmpeg를 사용하는 방식과,  
Ubuntu 버전에 따른 ffmpeg 버전 차이로 인한 호환성 문제의 해결 설계를 기술합니다.

**범위:**
- `server/src/services/rtspCapture.js` — RTSP 프레임 캡처 서비스
- `server/src/services/youtubeStreamService.js` — YouTube 스트림 변환
- `server/src/services/pipelineManager.js` — 파이프라인 오케스트레이션

**범위 외:**
- MediaMTX 프록시 설정 (→ `camera-stream-setup` SKILL)
- WebRTC SFU (→ `Design_WebRTC_Media_Gateway.md`)

---

## 2. 아키텍처 개요

```
IP 카메라 (RTSP/554)
    │
    ▼ TCP 연결
┌──────────────────────────────────────────────┐
│  RTSPCapture (rtspCapture.js)                │
│                                              │
│  ffmpeg [입력 옵션] -i rtsp://... [출력]      │
│    └─ stdout → JPEG 스트림 파싱              │
│    └─ stderr → 로그 필터링 / 재연결 트리거   │
└──────────────────┬───────────────────────────┘
                   │ frame 이벤트 (JPEG Buffer)
                   ▼
         PipelineManager
                   │
                   ▼
         detection.js (YOLOv8)
```

### ffmpeg 프로세스 생명주기

```
start() → _spawn() → spawn('ffmpeg', args)
              │
    ┌─────────┴─────────┐
    │ stdout            │ stderr
    │ JPEG 파싱         │ 에러 로그 필터링
    │ frame 이벤트 발생  │ (error/Unable/401 등)
    └─────────┬─────────┘
              │ close 이벤트
              ▼
         _scheduleRetry() → 1초 후 _spawn() 재시도
```

---

## 3. ffmpeg 버전 감지 설계

### 3.1 감지 시점

서버 기동 시 모듈 로드 단계(top-level)에서 **1회만** 실행합니다.  
카메라 연결마다 실행하지 않아 오버헤드가 없습니다.

```javascript
// rtspCapture.js — 모듈 로드 시 1회 실행
function _detectFfmpegMajor() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/ffmpeg version (\d+)/);
    return m ? parseInt(m[1], 10) : 4;
  } catch (_) {
    return 4; // ffmpeg 미설치 시 안전 기본값; spawn 에러가 별도 처리됨
  }
}

const FFMPEG_MAJOR = _detectFfmpegMajor();
```

### 3.2 버전별 플래그 선택

```javascript
// ffmpeg 3.x (Ubuntu 18.04): -stimeout
// ffmpeg 4+  (Ubuntu 20.04+): -timeout
const RTSP_TIMEOUT_ARGS = FFMPEG_MAJOR < 4
  ? ['-stimeout', '5000000']
  : ['-timeout',  '5000000'];
```

| 조건 | 플래그 | 단위 | 설명 |
|------|--------|------|------|
| `FFMPEG_MAJOR < 4` | `-stimeout` | µs | RTSP 소켓 타임아웃 (socket timeout) |
| `FFMPEG_MAJOR >= 4` | `-timeout` | µs | AVOption 타임아웃 (입력 옵션) |

### 3.3 플래그 배치 위치 (중요)

두 플래그 모두 반드시 **`-i` 앞에** 배치해야 입력 AVOption으로 해석됩니다.  
`-i` 뒤에 두면 출력 옵션으로 해석되어 타임아웃이 적용되지 않습니다.

```bash
# ✅ 올바른 배치
ffmpeg -rtsp_transport tcp -fflags +genpts+igndts -timeout 5000000 \
       -analyzeduration 1000000 -probesize 1000000 \
       -i rtsp://... [출력 옵션]

# ❌ 잘못된 배치 (출력 옵션으로 해석됨)
ffmpeg -rtsp_transport tcp -i rtsp://... -timeout 5000000 [출력 옵션]
```

---

## 4. RTSP 캡처 파이프라인

### 4.1 전체 ffmpeg 명령

```bash
ffmpeg \
  -rtsp_transport tcp          \  # TCP로 RTSP 연결 (방화벽 친화적)
  -fflags +genpts+igndts       \  # 깨진 타임스탬프 정규화
  [-stimeout|-timeout] 5000000 \  # 소켓 타임아웃 5초 (µs)
  -analyzeduration 1000000     \  # 입력 분석 시간 1초
  -probesize 1000000           \  # 입력 프로브 크기
  -i rtsp://user:pass@IP/PATH  \  # RTSP 소스
  -vf fps=10,scale=640:-2      \  # 10fps, 너비 640 리샘플
  -f image2pipe                \  # JPEG 스트림으로 출력
  -vcodec mjpeg                \
  -q:v 5                       \  # JPEG 품질 (1=최고, 31=최저)
  pipe:1                           # stdout으로 출력
```

### 4.2 JPEG 프레임 파싱

ffmpeg stdout은 연속적인 JPEG 바이트 스트림입니다.  
`_onData()`에서 SOI(`FF D8 FF`) / EOI(`FF D9`) 마커로 프레임을 추출합니다.

```
stdout: [FF D8 FF ... FF D9][FF D8 FF ... FF D9][FF D8 FF ... (불완전)]
         ← 프레임 1 ─────→  ← 프레임 2 ─────→  ← 버퍼에 보관 →
```

### 4.3 stderr 필터링

ffmpeg의 stderr는 방대한 코덱 로그를 출력합니다.  
`/frame=|fps=|Error|error|No such|Invalid|Unable|Connection refused|Authentication|401/` 패턴에 해당하는 줄만 `warn` 이벤트로 전파합니다.

---

## 5. ffmpeg 버전별 CLI 플래그 차이

| 플래그 | 3.4.x | 4.x | 5.x | 6.x | 7.x | 비고 |
|--------|-------|-----|-----|-----|-----|------|
| `-stimeout` | ✅ | ✅ | ✅ | ⚠️ deprecated | ❌ 제거 | RTSP 전용 소켓 타임아웃 |
| `-timeout` | ❌ 글로벌 충돌 | ✅ | ✅ | ✅ | ✅ | AVOption 타임아웃 |
| `-rtsp_transport` | ✅ | ✅ | ✅ | ✅ | ✅ | tcp/udp/http 선택 |
| `-fflags +genpts` | ✅ | ✅ | ✅ | ✅ | ✅ | PTS 재생성 |
| `-fflags +igndts` | ✅ | ✅ | ✅ | ✅ | ✅ | DTS 무시 |
| `-analyzeduration` | ✅ | ✅ | ✅ | ✅ | ✅ | 입력 분석 시간 |
| `-probesize` | ✅ | ✅ | ✅ | ✅ | ✅ | 입력 프로브 크기 |

### ffmpeg 3.4에서 `-timeout` 사용 시 장애 원인

ffmpeg 3.4의 RTSP 핸들러(`libavformat/rtsp.c`)는 `-timeout`을 글로벌 소켓 컨텍스트에 적용할 때,  
해당 소켓을 리스닝 모드로 초기화하는 코드 경로를 거칩니다.  
이때 카메라 IP를 로컬에 바인드하려다 `EADDRNOTAVAIL` 오류가 발생합니다.

```
[rtsp @ 0x...] Unable to open RTSP for listening     ← 리스닝 모드 진입 시도
...: Cannot assign requested address                  ← EADDRNOTAVAIL (카메라 IP를 바인드 불가)
```

ffmpeg 4.x에서는 `-timeout`이 명확히 입력 AVOption으로 처리되어 이 문제가 없습니다.

---

## 6. 오류 처리 및 재연결

### 6.1 재연결 정책

| 상황 | 동작 |
|------|------|
| ffmpeg 정상 종료 (`code=0`) | 1초 후 재연결 |
| ffmpeg 비정상 종료 (`code≠0`) | 1초 후 재연결 |
| SIGKILL | 재연결 (단, `stop()` 호출 후면 중단) |
| `ENOENT` (ffmpeg 미설치) | **즉시 중단**, `error` 이벤트 발생 |

### 6.2 ffmpeg 미설치 탐지

```javascript
proc.on('error', (err) => {
  if (err.code === 'ENOENT') {
    this._running = false;
    this.emit('error', new Error('ffmpeg not found. Install ffmpeg to enable RTSP capture.'));
    return;
  }
  this._scheduleRetry();
});
```

### 6.3 연결 성공 판단 기준

첫 번째 stdout 데이터(`_onData()`) 수신 시 `_connected = true`로 전환하고 재시도 카운터를 초기화합니다.  
단순 ffmpeg 프로세스 기동이 아니라 실제 프레임 수신으로 판단합니다.

---

## 7. YouTube → RTSP 파이프라인에서의 ffmpeg

YouTube 스트림은 `youtubeStreamService.js`에서 다른 ffmpeg 명령을 사용합니다.

```bash
# yt-dlp 로 스트림 URL 추출 → ffmpeg 로 RTSP 재인코딩
yt-dlp [url] --get-url → ffmpeg -i [url] -c copy -f rtsp rtsp://localhost:8554/yt_[id]
```

YouTube 스트림에서도 ffmpeg 버전 의존성이 있습니다:

| 플래그 | 3.4 | 4+ | 비고 |
|--------|-----|----|------|
| `-c copy` | ✅ | ✅ | 재인코딩 없이 복사 |
| `-f rtsp` | ✅ | ✅ | RTSP 출력 |
| `-rtsp_transport tcp` | ✅ | ✅ | RTSP 출력 전송 방식 |

---

## 8. 환경변수 참조

| 변수 | 기본값 | 관련 서비스 | 설명 |
|------|--------|------------|------|
| `YTDLP_BIN` | _(PATH 탐색)_ | youtubeStreamService | yt-dlp 바이너리 절대경로 |
| `MEDIAMTX_BIN` | _(PATH 탐색)_ | youtubeStreamService | mediamtx 바이너리 절대경로 |
| `MAX_PIPELINES` | `0` | pipelineManager | 동시 ffmpeg 프로세스 상한 (0=무제한) |
| `YOUTUBE_MAX_STREAMS` | `2` | youtubeStreamService | YouTube 전용 스트림 상한 |
| `YOUTUBE_MAX_RESTARTS` | `5` | youtubeStreamService | 자동 재시작 한계 |

---

## 9. 향후 고려사항

| 항목 | 설명 | 우선순위 |
|------|------|---------|
| ffmpeg 8.x 대응 | 현재 감지 로직은 `Major < 4` / `>= 4`로 충분. ffmpeg 8에서 추가 변경 발생 시 감지 로직 확장 필요 | Low |
| Docker 환경 고정 | `Dockerfile`에 ffmpeg 버전을 고정하면 환경 차이 문제 자체를 제거 가능 (`RUN apt install ffmpeg=4.4.*`) | Medium |
| Hardware 가속 | NVIDIA GPU 환경에서 `-hwaccel cuda` 사용 시 ffmpeg CUDA 빌드 필요. ONNX_CUDA와 별개임에 주의 | Low |
| HLS 대안 검토 | ffmpeg를 직접 사용하는 대신 MediaMTX의 HLS 출력을 소비하는 방식으로 전환하면 버전 의존성 제거 가능 | Low |
