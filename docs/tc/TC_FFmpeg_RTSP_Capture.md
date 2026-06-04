# TEST CASES
# FFmpeg RTSP Capture — 버전 호환성 및 기능 검증

| | |
|---|---|
| **Document ID** | TC-LTS-FFMPEG-001 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-04 |
| **Related Design** | [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) |
| **Related Ops** | [FFmpeg_Installation_Compatibility.md](../ops/FFmpeg_Installation_Compatibility.md) |
| **Test Target** | `server/src/services/rtspCapture.js` |

---

## 사전 조건

- 서버가 실행 중이고 `/health` 엔드포인트가 `{ "status": "ok" }` 응답
- 테스트용 RTSP 카메라 또는 MediaMTX 로컬 스트림이 준비되어 있음
- `ffmpeg -version` 으로 현재 버전을 확인한 후 해당 섹션의 TC를 수행

---

## TC-FFMPEG-001 — ffmpeg 설치 확인

| 항목 | 내용 |
|------|------|
| **목적** | ffmpeg가 시스템에 설치되어 있고 실행 가능한지 확인 |
| **우선순위** | P0 (선결 조건) |

**절차:**
```bash
ffmpeg -version
```

**합격 기준:**
- 종료 코드 0
- `ffmpeg version X.Y.Z` 형식의 첫 줄 출력
- 버전이 지원 매트릭스(3.4 이상)에 속함

**실패 시 조치:** [FFmpeg_Installation_Compatibility.md](../ops/FFmpeg_Installation_Compatibility.md)의 설치 방법 참조

---

## TC-FFMPEG-002 — ffmpeg 버전 자동 감지

| 항목 | 내용 |
|------|------|
| **목적** | `rtspCapture.js`가 서버 기동 시 ffmpeg Major 버전을 올바르게 감지하는지 확인 |
| **우선순위** | P0 |

**절차:**
```bash
# 서버 기동 후 로그에서 ffmpeg 버전 감지 결과 확인
grep -i "ffmpeg version\|FFMPEG_MAJOR\|stimeout\|timeout" /tmp/lts-server.log | head -10

# 또는 Node.js에서 직접 확인
node -e "
const { spawnSync } = require('child_process');
const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
const m = r.stdout.match(/ffmpeg version (\d+)/);
const major = m ? parseInt(m[1]) : -1;
console.log('Major:', major);
console.log('Timeout flag:', major < 4 ? '-stimeout' : '-timeout');
"
```

**합격 기준:**
- Ubuntu 18.04: Major = 3, 플래그 = `-stimeout`
- Ubuntu 20.04/22.04: Major = 4, 플래그 = `-timeout`
- Ubuntu 24.04: Major = 6, 플래그 = `-timeout`
- Ubuntu 26.04: Major = 7, 플래그 = `-timeout`

---

## TC-FFMPEG-003 — 올바른 timeout 플래그로 RTSP 연결 성공

| 항목 | 내용 |
|------|------|
| **목적** | 버전에 맞는 timeout 플래그로 RTSP 스트림이 정상 수신되는지 확인 |
| **우선순위** | P0 |

**절차 (Ubuntu 18.04 — ffmpeg 3.4):**
```bash
# -stimeout 사용 (✅)
ffmpeg -rtsp_transport tcp -stimeout 5000000 \
  -analyzeduration 1000000 -probesize 1000000 \
  -i 'rtsp://CAMERA_USER:CAMERA_PASS@CAMERA_IP/RTSP_PATH' \
  -frames:v 1 /tmp/tc003_cam.jpg && echo "PASS" || echo "FAIL"
```

**절차 (Ubuntu 20.04+ — ffmpeg 4+):**
```bash
# -timeout 사용 (✅)
ffmpeg -rtsp_transport tcp -timeout 5000000 \
  -analyzeduration 1000000 -probesize 1000000 \
  -i 'rtsp://CAMERA_USER:CAMERA_PASS@CAMERA_IP/RTSP_PATH' \
  -frames:v 1 /tmp/tc003_cam.jpg && echo "PASS" || echo "FAIL"
```

**합격 기준:**
- 종료 코드 0
- `/tmp/tc003_cam.jpg` 파일 생성 (크기 > 0)
- stderr에 `Unable to open RTSP for listening` 없음
- stderr에 `Cannot assign requested address` 없음

---

## TC-FFMPEG-004 — 잘못된 timeout 플래그 사용 시 장애 재현 (Ubuntu 18.04 한정)

| 항목 | 내용 |
|------|------|
| **목적** | ffmpeg 3.4에서 `-timeout` 사용 시 발생하는 알려진 장애를 재현하여 원인을 이해 |
| **우선순위** | P1 (Ubuntu 18.04 환경에서만 수행) |
| **환경** | Ubuntu 18.04 (ffmpeg 3.4.x) |

**절차:**
```bash
ffmpeg -rtsp_transport tcp -timeout 5000000 \
  -i 'rtsp://CAMERA_USER:CAMERA_PASS@CAMERA_IP/RTSP_PATH' \
  -frames:v 1 /tmp/tc004_fail.jpg 2>&1 | tail -5
```

**합격 기준 (의도적 실패 확인):**
- `Unable to open RTSP for listening` 메시지 포함
- `Cannot assign requested address` 메시지 포함
- 종료 코드 ≠ 0

---

## TC-FFMPEG-005 — API를 통한 카메라 파이프라인 상태 확인

| 항목 | 내용 |
|------|------|
| **목적** | 서버 재시작 후 카메라 파이프라인이 프레임을 수신하는지 API로 확인 |
| **우선순위** | P0 |

**절차:**
```bash
# 서버 기동 30초 후 상태 확인
sleep 30
curl -sk https://localhost:3443/api/cameras | \
  node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const cams = d.data || d;
  cams.forEach(c => {
    const ok = c.pipelineStatus?.frameCount > 0;
    console.log((ok?'PASS':'FAIL'), c.name, 'status:', c.status, 'frames:', c.pipelineStatus?.frameCount);
  });
  "
```

**합격 기준:**
- 각 카메라의 `status` = `"active"` (또는 `"streaming"`)
- 각 카메라의 `pipelineStatus.frameCount` > 0
- `pipelineStatus.lastFrameAt` ≠ `null`

---

## TC-FFMPEG-006 — 카메라 재연결 동작 확인

| 항목 | 내용 |
|------|------|
| **목적** | ffmpeg 프로세스가 종료된 후 자동으로 재연결하는지 확인 |
| **우선순위** | P1 |

**절차:**
```bash
# 1. 현재 ffmpeg PID 확인
FFPID=$(pgrep -f "rtsp://.*media.smp" | head -1)
echo "Killing ffmpeg PID: $FFPID"

# 2. ffmpeg 강제 종료
kill -9 $FFPID

# 3. 3초 후 새 ffmpeg 프로세스 생성 확인
sleep 3
pgrep -f "rtsp://.*media.smp" | wc -l
```

**합격 기준:**
- 종료 후 1~2초 이내에 새 ffmpeg 프로세스 생성
- 서버 로그에 `Reconnecting... attempt N` 메시지 출력
- 이후 `status`가 다시 `active`로 전환

---

## TC-FFMPEG-007 — ffmpeg 미설치 시 에러 처리

| 항목 | 내용 |
|------|------|
| **목적** | ffmpeg가 없을 때 서버가 명확한 에러를 출력하고 크래시 없이 동작하는지 확인 |
| **우선순위** | P1 |

**절차:**
```bash
# ffmpeg를 임시로 숨기고 서버 동작 확인 (PATH 조작)
PATH_BAK=$PATH
export PATH=/usr/bin/false_path:$PATH
node -e "
const RTSPCapture = require('./server/src/services/rtspCapture.js');
const cap = new RTSPCapture('test-id', 'rtsp://localhost/test');
cap.on('error', e => { console.log('PASS — error caught:', e.message); process.exit(0); });
cap.start();
setTimeout(() => { console.log('FAIL — no error event'); process.exit(1); }, 3000);
"
export PATH=$PATH_BAK
```

**합격 기준:**
- `error` 이벤트 발생
- 에러 메시지에 `ffmpeg not found` 포함
- 무한 재시도 루프 없음 (프로세스 정상 종료)

---

## TC-FFMPEG-008 — YouTube 스트림 ffmpeg 버전 호환성

| 항목 | 내용 |
|------|------|
| **목적** | YouTube 스트림 수집에 사용되는 ffmpeg 명령이 현재 버전에서 동작하는지 확인 |
| **우선순위** | P1 |

**절차:**
```bash
# yt-dlp 설치 확인
yt-dlp --version

# 공개 스트림으로 ffmpeg 파이프라인 테스트 (Big Buck Bunny 샘플)
STREAM_URL=$(yt-dlp -g "https://www.youtube.com/watch?v=YE7VzlLtp-4" 2>/dev/null | head -1)
if [ -z "$STREAM_URL" ]; then echo "SKIP — yt-dlp failed"; exit 0; fi

ffmpeg -i "$STREAM_URL" -c copy -t 3 /tmp/tc008_yt.mp4 2>&1 | tail -5
ls -la /tmp/tc008_yt.mp4 && echo "PASS" || echo "FAIL"
```

**합격 기준:**
- yt-dlp 버전 출력 성공
- ffmpeg로 3초 분량 영상 저장 성공
- `/tmp/tc008_yt.mp4` 크기 > 0

---

## TC-FFMPEG-009 — 전체 통합 검증 스크립트

| 항목 | 내용 |
|------|------|
| **목적** | 위 TC들을 묶어 신규 운영 환경 셋업 완료 시 일괄 검증 |
| **우선순위** | P0 (운영 환경 배포 후 필수) |

```bash
#!/bin/bash
PASS=0; FAIL=0

check() {
  local name=$1; shift
  if "$@" &>/dev/null; then
    echo "PASS  $name"; ((PASS++))
  else
    echo "FAIL  $name"; ((FAIL++))
  fi
}

# TC-001: ffmpeg 설치
check "TC-001 ffmpeg 설치" ffmpeg -version

# TC-002: 버전 감지
MAJOR=$(ffmpeg -version 2>&1 | grep -oP 'ffmpeg version \K\d+')
check "TC-002 버전 감지 (Major=$MAJOR)" test -n "$MAJOR"

# TC-003: RTSP 연결 (카메라 IP 필요)
RTSP_URL="${RTSP_TEST_URL:-}"
if [ -n "$RTSP_URL" ]; then
  check "TC-003 RTSP 연결" ffmpeg -rtsp_transport tcp \
    -i "$RTSP_URL" -frames:v 1 /tmp/tc_rtsp.jpg
else
  echo "SKIP  TC-003 RTSP (RTSP_TEST_URL 미설정)"
fi

# TC-005: API 카메라 상태
check "TC-005 서버 헬스" curl -sk https://localhost:3443/health

echo ""
echo "결과: PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && exit 0 || exit 1
```

---

## 합격/불합격 판정 기준 요약

| TC | 조건 | 비고 |
|----|------|------|
| TC-001 | ffmpeg 설치됨 | 필수 사전 조건 |
| TC-002 | Major 버전 정확히 감지 | 런타임 자동 처리 |
| TC-003 | 카메라 1프레임 캡처 성공 | 핵심 기능 |
| TC-004 | 3.4 장애 재현 (의도적) | 이해 검증 |
| TC-005 | frameCount > 0 | 운영 검증 |
| TC-006 | 1초 이내 재연결 | 안정성 |
| TC-007 | 미설치 시 error 이벤트 | 방어 코드 |
| TC-008 | YouTube 3초 캡처 성공 | 확장 기능 |
| TC-009 | 일괄 통과 | 배포 후 게이트 |
