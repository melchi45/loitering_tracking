# Operations Guide
# FFmpeg Installation & Version Compatibility

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-FFMPEG-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-06-04 |
| **Status** | **✅ Active** |
| **Related Design** | [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) |

---

## 개요

LTS-2026은 RTSP 카메라 스트림 프레임 수집과 YouTube → RTSP 변환에 `ffmpeg`를 직접 사용합니다.  
ffmpeg는 Ubuntu 버전에 따라 설치되는 버전이 다르며, **CLI 플래그 이름·동작이 버전마다 다릅니다.**  
개발 환경과 운영 환경의 Ubuntu 버전이 다를 경우 카메라 영상이 전혀 나오지 않는 장애가 발생할 수 있습니다.

---

## Ubuntu 버전별 ffmpeg 지원 매트릭스

| Ubuntu 버전 | 기본 제공 ffmpeg | RTSP timeout 플래그 | `-stimeout` | `-timeout` | 비고 |
|------------|----------------|---------------------|-------------|------------|------|
| **18.04 LTS** (Bionic) | **3.4.x** | `-stimeout` | ✅ 정상 | ❌ 장애 유발 | `-timeout`을 글로벌 옵션으로 사용 시 RTSP가 리스닝 모드로 오동작 |
| **20.04 LTS** (Focal)  | **4.2.x** | `-timeout` 권장 | ✅ 호환 | ✅ 정상 | 두 플래그 모두 동작 |
| **22.04 LTS** (Jammy)  | **4.4.x** | `-timeout` 권장 | ✅ 호환 | ✅ 정상 | 두 플래그 모두 동작 |
| **24.04 LTS** (Noble)  | **6.1.x** | `-timeout` | ⚠️ deprecated | ✅ 정상 | `-stimeout` 사용 시 경고 출력 |
| **26.04 LTS** (Oracular)| **7.x** | `-timeout` | ❌ 제거됨 | ✅ 정상 | `-stimeout` 옵션 자체가 없음 |

> **중요:** 이 프로젝트는 Ubuntu 26.04 (ffmpeg 7.x) 환경에서 개발·커밋되었습니다.  
> 다른 Ubuntu 버전에서 실행하는 경우 아래 설치 방법을 따르십시오.

---

## ffmpeg 설치

### 방법 1 — apt 기본 패키지 (권장, Ubuntu 버전 일치 시)

```bash
sudo apt update
sudo apt install -y ffmpeg

# 설치 버전 확인
ffmpeg -version | head -1
```

### 방법 2 — 최신 정적 빌드 (버전 고정이 필요한 경우)

```bash
# 최신 ffmpeg 정적 빌드 다운로드 (johnvansickle.com)
wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz
sudo cp ffmpeg-*-static/ffmpeg /usr/local/bin/ffmpeg
sudo chmod +x /usr/local/bin/ffmpeg

# 시스템 기본 ffmpeg보다 우선 적용되도록 PATH 확인
which ffmpeg   # /usr/local/bin/ffmpeg 이어야 함
ffmpeg -version | head -1
```

### 방법 3 — PPA (Ubuntu 20.04 이상에서 최신 버전 설치)

```bash
sudo add-apt-repository ppa:savoury1/ffmpeg4  # ffmpeg 4.x
# 또는
sudo add-apt-repository ppa:savoury1/ffmpeg5  # ffmpeg 5.x
sudo apt update && sudo apt install -y ffmpeg
```

---

## 버전별 알려진 문제와 해결책

### Ubuntu 18.04 — ffmpeg 3.4.x

**증상:**
```
[rtsp @ 0x...] Unable to open RTSP for listening
rtsp://admin:pass@192.168.x.x/...: Cannot assign requested address
ffmpeg exited (code=1 signal=null)
```

**원인:**  
ffmpeg 3.4에서 `-timeout` 옵션을 `-i` 앞 글로벌 위치에 두면 RTSP 핸들러가 클라이언트 모드 대신 서버(리스닝) 모드로 초기화를 시도합니다. 서버가 카메라 IP를 로컬에 바인드하려다 `EADDRNOTAVAIL` 오류가 발생합니다.

**해결:**  
LTS-2026 `rtspCapture.js`는 서버 기동 시 `ffmpeg -version`을 실행하여 Major 버전을 감지하고 자동으로 플래그를 전환합니다:

```javascript
const RTSP_TIMEOUT_ARGS = FFMPEG_MAJOR < 4
  ? ['-stimeout', '5000000']   // ffmpeg 3.x
  : ['-timeout',  '5000000'];  // ffmpeg 4+
```

수동 테스트 방법:
```bash
# -stimeout 으로 테스트
ffmpeg -rtsp_transport tcp -stimeout 5000000 \
  -i 'rtsp://admin:PASS@CAMERA_IP/PATH' \
  -frames:v 1 /tmp/test.jpg
```

---

### Ubuntu 24.04 / 26.04 — ffmpeg 6.x / 7.x

**증상 (26.04에서 구 플래그 사용 시):**
```
Option stimeout not found.
```

**원인:** ffmpeg 7.0에서 `-stimeout`이 제거되었습니다.

**해결:** `rtspCapture.js`의 자동 감지 로직이 ffmpeg 4+에서는 `-timeout`을 사용합니다. 별도 조치 불필요.

---

## 설치 확인 체크리스트

```bash
# 1. ffmpeg 설치 여부 및 버전
ffmpeg -version | head -1

# 2. RTSP 스트림 직접 테스트 (카메라 1대)
ffmpeg -rtsp_transport tcp \
  -i 'rtsp://admin:PASSWORD@CAMERA_IP/0/H.264/media.smp' \
  -frames:v 1 /tmp/cam_test.jpg && echo "OK" || echo "FAIL"

# 3. 서버 기동 후 ffmpeg 버전 감지 확인
grep "ffmpeg\|FFMPEG" /tmp/lts-server.log | head -5

# 4. 카메라 파이프라인 상태 확인
curl -sk https://localhost:3443/api/cameras | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
  (d.data||d).forEach(c=>console.log(c.name, c.status, 'frames:', c.pipelineStatus?.frameCount))"
```

---

## 환경변수 (관련 `.env` 항목)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `YTDLP_BIN` | _(empty)_ | yt-dlp 바이너리 절대경로. 비워두면 PATH에서 탐색 |
| `MEDIAMTX_BIN` | _(empty)_ | mediamtx 바이너리 절대경로. 비워두면 PATH에서 탐색 |
| `MAX_PIPELINES` | `0` | 동시 ffmpeg 프로세스 최대 수 (0=무제한) |
| `YOUTUBE_MAX_STREAMS` | `2` | YouTube 전용 ffmpeg 스트림 최대 수 |

---

## 관련 문서

- [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) — 기술 설계
- [TC_FFmpeg_RTSP_Capture.md](../tc/TC_FFmpeg_RTSP_Capture.md) — 테스트 케이스
- [Design_LTS2026_YouTube_RTSP_Ingest.md](../design/Design_LTS2026_YouTube_RTSP_Ingest.md) — YouTube 스트림 설계
