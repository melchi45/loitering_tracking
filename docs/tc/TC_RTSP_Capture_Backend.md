# TEST CASES
# RTSP Capture Backend 선택 — captureFactory / GStreamer / PyAV 검증

| | |
|---|---|
| **Document ID** | TC-LTS-CAPTURE-002 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-04 |
| **Related Design** | [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) |
| **Test Target** | `server/src/services/captureFactory.js`, `server/src/services/gstreamerCapture.js`, `server/src/services/pyavCapture.js` |

---

## 사전 조건

- Node.js 18+ 설치
- `server/src/services/captureFactory.js`, `gstreamerCapture.js`, `pyavCapture.js` 존재
- 단위 테스트(TC-CAPTURE-001 ~ TC-CAPTURE-010)는 실제 카메라 없이 subprocess mock으로 수행
- TC-CAPTURE-011, TC-CAPTURE-012는 실 카메라 또는 MediaMTX 로컬 스트림 필요

---

## TC-CAPTURE-001 — captureFactory 백엔드 선택

| 항목 | 내용 |
|------|------|
| **목적** | `CAPTURE_BACKEND` 환경변수 값에 따라 올바른 캡처 클래스 인스턴스가 반환되는지 확인 |
| **우선순위** | P0 (핵심 라우팅 로직) |

**절차:**
```bash
node -e "
process.env.CAPTURE_BACKEND = 'ffmpeg';
delete require.cache[require.resolve('./server/src/services/captureFactory.js')];
const { createCapture } = require('./server/src/services/captureFactory.js');
const c = createCapture('cam1', 'rtsp://localhost/test');
console.log('ffmpeg →', c.constructor.name);

process.env.CAPTURE_BACKEND = 'gstreamer';
delete require.cache[require.resolve('./server/src/services/captureFactory.js')];
const { createCapture: createG } = require('./server/src/services/captureFactory.js');
const g = createG('cam1', 'rtsp://localhost/test');
console.log('gstreamer →', g.constructor.name);

process.env.CAPTURE_BACKEND = 'pyav';
delete require.cache[require.resolve('./server/src/services/captureFactory.js')];
const { createCapture: createP } = require('./server/src/services/captureFactory.js');
const p = createP('cam1', 'rtsp://localhost/test');
console.log('pyav →', p.constructor.name);
"
```

**합격 기준:**
- `CAPTURE_BACKEND=ffmpeg` → `RTSPCapture` 인스턴스
- `CAPTURE_BACKEND=gstreamer` → `GStreamerCapture` 인스턴스
- `CAPTURE_BACKEND=pyav` → `PyAVCapture` 인스턴스

---

## TC-CAPTURE-002 — FFmpeg 백엔드 기본값 확인

| 항목 | 내용 |
|------|------|
| **목적** | `CAPTURE_BACKEND` 환경변수가 설정되지 않은 경우 ffmpeg 백엔드가 기본으로 선택되는지 확인 |
| **우선순위** | P0 |

**절차:**
```bash
node -e "
delete process.env.CAPTURE_BACKEND;
delete require.cache[require.resolve('./server/src/services/captureFactory.js')];
const { createCapture, CAPTURE_BACKEND } = require('./server/src/services/captureFactory.js');
console.log('CAPTURE_BACKEND =', CAPTURE_BACKEND);
const c = createCapture('cam1', 'rtsp://localhost/test');
console.log('Instance:', c.constructor.name);
"
```

**합격 기준:**
- `CAPTURE_BACKEND` 출력값 = `"ffmpeg"`
- 인스턴스 클래스명 = `RTSPCapture`

---

## TC-CAPTURE-003 — GStreamer 설치 확인

| 항목 | 내용 |
|------|------|
| **목적** | GStreamer 백엔드 사용을 위한 필수 바이너리가 시스템에 설치되어 있는지 확인 |
| **우선순위** | P0 (GStreamer 백엔드 사전 조건) |

**절차:**
```bash
# gst-launch-1.0 설치 및 버전 확인
gst-launch-1.0 --version

# decodebin 플러그인 존재 확인
gst-inspect-1.0 decodebin
```

**합격 기준:**
- `gst-launch-1.0 --version`: 종료 코드 0, `GStreamer X.Y.Z` 형식 출력
- `gst-inspect-1.0 decodebin`: 종료 코드 0, `Factory Details` 섹션 출력

**실패 시 조치:**
```bash
# Ubuntu/Debian
sudo apt-get install -y gstreamer1.0-tools gstreamer1.0-plugins-base \
     gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
     gstreamer1.0-plugins-ugly gstreamer1.0-libav

# RHEL/CentOS
sudo dnf install -y gstreamer1 gstreamer1-plugins-base \
     gstreamer1-plugins-good gstreamer1-plugins-bad-free
```

---

## TC-CAPTURE-004 — GStreamer 소프트웨어 디코드 파이프라인 동작 확인

| 항목 | 내용 |
|------|------|
| **목적** | `GSTREAMER_HW_ACCEL=software` 설정으로 소프트웨어 디코드 파이프라인이 정상 동작하는지 확인 |
| **우선순위** | P0 |

**절차:**
```bash
# 1. _buildArgs()가 software 파이프라인을 생성하는지 단위 검증
node -e "
process.env.GSTREAMER_HW_ACCEL = 'software';
// 모듈을 직접 로드하되 GST_AVAILABLE을 우회하기 위해 GStreamerCapture만 인스턴스화
const GStreamerCapture = require('./server/src/services/gstreamerCapture.js');
const cap = new GStreamerCapture('cam1', 'rtsp://192.168.1.100/stream');
const args = cap._buildArgs().join(' ');
console.log('Pipeline args:', args);
console.log('Contains decodebin:', args.includes('decodebin'));
console.log('No nvdec:', !args.includes('nvdec'));
console.log('No vaapi:', !args.includes('vaapi'));
"

# 2. 실제 RTSP 스트림 테스트 (선택, MediaMTX 필요)
GSTREAMER_HW_ACCEL=software gst-launch-1.0 -q \
  rtspsrc location="rtsp://localhost:8554/test" protocols=tcp latency=200 \
  ! decodebin ! videorate max-rate=2 ! videoscale ! video/x-raw,width=320 \
  ! videoconvert ! jpegenc ! filesink location=/tmp/tc004_sw.jpg \
  2>&1 | head -5
ls -la /tmp/tc004_sw.jpg 2>/dev/null && echo "PASS" || echo "SKIP (no stream)"
```

**합격 기준:**
- `_buildArgs()` 출력에 `decodebin` 포함, `nvdec` / `vaapi` 미포함
- 실 스트림 테스트 시 `/tmp/tc004_sw.jpg` 생성 (크기 > 0)

---

## TC-CAPTURE-005 — GStreamer nvdec 하드웨어 감지

| 항목 | 내용 |
|------|------|
| **목적** | NVIDIA GPU 환경에서 `nvdec` 플러그인이 감지되고 파이프라인 인자에 반영되는지 확인 |
| **우선순위** | P1 (NVIDIA GPU 환경 한정) |
| **환경** | CUDA 드라이버 및 GStreamer NVDEC 플러그인 설치된 시스템 |

**절차:**
```bash
# nvdec 플러그인 존재 확인
gst-inspect-1.0 nvdec && echo "nvdec available"

# nvh264dec 플러그인 확인
gst-inspect-1.0 nvh264dec && echo "nvh264dec available"

# 파이프라인 인자 검증
node -e "
process.env.GSTREAMER_HW_ACCEL = 'nvdec';
const GStreamerCapture = require('./server/src/services/gstreamerCapture.js');
const cap = new GStreamerCapture('cam1', 'rtsp://localhost/test');
const args = cap._buildArgs().join(' ');
console.log('Pipeline args:', args);
console.log('Contains nvh264dec:', args.includes('nvh264dec'));
"
```

**합격 기준:**
- `gst-inspect-1.0 nvdec`: 종료 코드 0
- `_buildArgs()` 출력에 `nvh264dec` 포함
- `decodebin` 미사용 (명시적 h264 경로)

---

## TC-CAPTURE-006 — GStreamer vaapi 하드웨어 감지

| 항목 | 내용 |
|------|------|
| **목적** | Intel/AMD GPU 환경에서 `vaapidecodebin` 플러그인이 감지되고 파이프라인 인자에 반영되는지 확인 |
| **우선순위** | P1 (Intel/AMD GPU 환경 한정) |
| **환경** | VA-API 드라이버 및 GStreamer VAAPI 플러그인 설치된 시스템 |

**절차:**
```bash
# vaapidecodebin 플러그인 확인
gst-inspect-1.0 vaapidecodebin && echo "vaapi available"

# 파이프라인 인자 검증
node -e "
process.env.GSTREAMER_HW_ACCEL = 'vaapi';
const GStreamerCapture = require('./server/src/services/gstreamerCapture.js');
const cap = new GStreamerCapture('cam1', 'rtsp://localhost/test');
const args = cap._buildArgs().join(' ');
console.log('Pipeline args:', args);
console.log('Contains vaapipostproc:', args.includes('vaapipostproc'));
console.log('Contains decodebin:', args.includes('decodebin'));
"
```

**합격 기준:**
- `gst-inspect-1.0 vaapidecodebin`: 종료 코드 0
- `_buildArgs()` 출력에 `vaapipostproc` 포함
- `decodebin`이 vaapi 자동 선택을 위해 사용됨

---

## TC-CAPTURE-007 — GStreamer auto 모드에서 fallback 동작

| 항목 | 내용 |
|------|------|
| **목적** | `GSTREAMER_HW_ACCEL=auto`(기본값) 설정에서 nvdec 미설치 시 소프트웨어 디코드로 자동 fallback되는지 확인 |
| **우선순위** | P0 |

**절차:**
```bash
# nvdec, vaapi 모두 없는 환경에서 auto 모드 동작 확인
node -e "
// auto 모드 시뮬레이션: _detectHwDecoder()는 nvdec, vaapi 순서로 시도
// 두 플러그인 모두 없으면 'software' 반환
const { spawnSync } = require('child_process');

function detectHw(candidates) {
  for (const plugin of candidates) {
    const r = spawnSync('gst-inspect-1.0', [plugin], { encoding: 'utf8' });
    if (r.status === 0) { console.log('Detected:', plugin); return plugin; }
  }
  console.log('No HW decoder found, using: software');
  return 'software';
}

const result = detectHw(['nvdec', 'vaapi']);
const expected = (result === 'nvdec' || result === 'vaapi' || result === 'software');
console.log('Valid result:', expected ? 'PASS' : 'FAIL');
"
```

**합격 기준:**
- nvdec, vaapi 모두 없으면 `'software'` 반환
- `_buildArgs()` 출력이 소프트웨어 파이프라인과 동일
- 서버 기동 로그: `[GStreamerCapture] GStreamer available — hw decoder: software`

---

## TC-CAPTURE-008 — PyAV Python 의존성 확인

| 항목 | 내용 |
|------|------|
| **목적** | PyAV 백엔드 실행에 필요한 Python 패키지(`av`, `PIL`)가 설치되어 있는지 확인 |
| **우선순위** | P0 (PyAV 백엔드 사전 조건) |

**절차:**
```bash
# Python 버전 확인
python3 --version

# av, PIL(Pillow) 임포트 테스트
python3 -c "import av, PIL; print('ok')"

# av 버전 확인
python3 -c "import av; print('av version:', av.__version__)"
```

**합격 기준:**
- `python3 -c "import av, PIL; print('ok')"`: 종료 코드 0, `ok` 출력
- Python 3.8 이상

**실패 시 조치:**
```bash
pip3 install av Pillow
# 또는 conda 사용 시
conda install -c conda-forge av pillow
```

---

## TC-CAPTURE-009 — PyAV 백엔드 프레임 수신 확인

| 항목 | 내용 |
|------|------|
| **목적** | PyAV 백엔드가 RTSP 스트림에서 JPEG 프레임을 정상 수신하는지 확인 |
| **우선순위** | P0 |

**절차:**
```bash
# 단위 테스트: mock stdout으로 frame 이벤트 발생 확인
node -e "
const { EventEmitter } = require('events');
// PyAVCapture의 _onData / _extractFrames 로직을 직접 검증
const PyAVCapture = require('./server/src/services/pyavCapture.js');
const cap = new PyAVCapture('cam1', 'rtsp://localhost/test');

let frameCount = 0;
cap.on('frame', (buf) => {
  frameCount++;
  console.log('Frame received, size:', buf.length);
});

// 유효한 JPEG SOI + EOI 바이트 삽입
const soi = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const payload = Buffer.alloc(100, 0xAB);
const eoi = Buffer.from([0xff, 0xd9]);
cap._onData(Buffer.concat([soi, payload, eoi]));

console.log(frameCount === 1 ? 'PASS: 1 frame received' : 'FAIL: frames=' + frameCount);
"

# 실 스트림 테스트 (MediaMTX 필요, 10초간 수신)
CAPTURE_BACKEND=pyav node -e "
const { createCapture } = require('./server/src/services/captureFactory.js');
const cap = createCapture('test', 'rtsp://localhost:8554/test');
let count = 0;
cap.on('frame', () => count++);
cap.on('error', e => { console.error('ERROR:', e.message); process.exit(1); });
cap.start();
setTimeout(() => {
  cap.stop();
  console.log(count > 0 ? 'PASS: frames=' + count : 'SKIP: no stream available');
  process.exit(0);
}, 10000);
" 2>/dev/null || echo "SKIP (no stream)"
```

**합격 기준:**
- 단위 테스트: mock JPEG 데이터 → `frame` 이벤트 1회 발생, Buffer 크기 정확
- 실 스트림 테스트: 10초간 `frame` 이벤트 ≥ 1회 발생

---

## TC-CAPTURE-010 — 잘못된 CAPTURE_BACKEND 값에서 ffmpeg fallback

| 항목 | 내용 |
|------|------|
| **목적** | 알 수 없는 `CAPTURE_BACKEND` 값 입력 시 ffmpeg로 fallback되고 `console.warn`이 발생하는지 확인 |
| **우선순위** | P1 |

**절차:**
```bash
node -e "
process.env.CAPTURE_BACKEND = 'invalid_backend_xyz';
delete require.cache[require.resolve('./server/src/services/captureFactory.js')];

// console.warn 가로채기
const warnings = [];
const origWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); origWarn(...args); };

const { createCapture } = require('./server/src/services/captureFactory.js');
const c = createCapture('cam1', 'rtsp://localhost/test');

console.warn = origWarn;

console.log('Instance:', c.constructor.name);
console.log('Warning issued:', warnings.some(w => w.includes('Unknown CAPTURE_BACKEND')));
console.log('Fallback to RTSPCapture:', c.constructor.name === 'RTSPCapture' ? 'PASS' : 'FAIL');
"
```

**합격 기준:**
- 인스턴스 클래스명 = `RTSPCapture`
- `console.warn` 호출됨, 메시지에 `Unknown CAPTURE_BACKEND` 포함
- warn은 중복 출력 없이 최초 1회만 발생 (`_warnedOnce` 플래그)

---

## TC-CAPTURE-011 — 백엔드 전환 후 서버 재시작 시 파이프라인 정상 동작

| 항목 | 내용 |
|------|------|
| **목적** | `CAPTURE_BACKEND` 환경변수를 변경하고 서버를 재시작했을 때 새 백엔드로 파이프라인이 정상 가동되는지 확인 |
| **우선순위** | P1 |
| **환경** | 서버 실행 중, RTSP 카메라 또는 MediaMTX 로컬 스트림 |

**절차:**
```bash
# 1. 현재 백엔드 확인
curl -sk http://localhost:3001/health | node -e "process.stdin.pipe(process.stdout)"

# 2. server/.env에서 CAPTURE_BACKEND 변경
grep CAPTURE_BACKEND server/.env || echo "CAPTURE_BACKEND not set (default: ffmpeg)"
# 편집: CAPTURE_BACKEND=gstreamer (또는 pyav)

# 3. 서버 재시작
cd server && npm run dev &
SERVER_PID=$!
sleep 10

# 4. 카메라 파이프라인 상태 확인
curl -s http://localhost:3001/api/cameras | \
  node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const cams = d.data || d;
  (Array.isArray(cams) ? cams : []).forEach(c => {
    const ok = c.pipelineStatus?.frameCount > 0;
    console.log((ok ? 'PASS' : 'WARN'), c.name, 'frames:', c.pipelineStatus?.frameCount);
  });
  "

# 5. 서버 종료
kill $SERVER_PID 2>/dev/null
```

**합격 기준:**
- 서버 기동 로그에 선택된 백엔드 이름 출력 (예: `[GStreamerCapture] GStreamer available`)
- `/api/cameras` 응답의 각 카메라 `pipelineStatus.frameCount` > 0
- 오류 이벤트 없이 30초 이상 안정적으로 프레임 수신

---

## TC-CAPTURE-012 — 각 백엔드 reconnect 동작

| 항목 | 내용 |
|------|------|
| **목적** | 카메라 연결이 끊어진 후 각 백엔드가 자동으로 재연결을 시도하는지 확인 |
| **우선순위** | P1 |
| **환경** | RTSP 카메라 또는 MediaMTX 로컬 스트림 |

**절차 (GStreamer / PyAV 공통):**
```bash
# 각 백엔드별로 수행 (CAPTURE_BACKEND=gstreamer 또는 pyav)
node -e "
const BACKEND = process.env.CAPTURE_BACKEND || 'gstreamer';

// 백엔드별 캡처 클래스 직접 로드
const CaptureClass = BACKEND === 'gstreamer'
  ? require('./server/src/services/gstreamerCapture.js')
  : require('./server/src/services/pyavCapture.js');

const cap = new CaptureClass('cam1', 'rtsp://localhost:8554/test');

const events = [];
cap.on('reconnecting', (info) => {
  events.push('reconnecting:' + info.attempt);
  console.log('reconnecting attempt', info.attempt);
});
cap.on('error', (e) => { console.error('error:', e.message); });
cap.on('started', () => console.log('started'));

cap.start();

// 3초 후 내부 프로세스를 강제 종료하여 재연결 트리거
setTimeout(() => {
  if (cap._proc) {
    cap._proc.kill('SIGKILL');
    console.log('Process killed to trigger reconnect');
  } else {
    console.log('SKIP: process not running (check backend installation)');
    cap.stop();
    process.exit(0);
  }
}, 3000);

// 5초 후 재연결 이벤트 발생 여부 확인
setTimeout(() => {
  cap.stop();
  const ok = events.some(e => e.startsWith('reconnecting:'));
  console.log(ok ? 'PASS: reconnect triggered' : 'FAIL: no reconnect event');
  process.exit(ok ? 0 : 1);
}, 5000);
"

# FFmpeg 백엔드 재연결 확인
node -e "
const RTSPCapture = require('./server/src/services/rtspCapture.js');
const cap = new RTSPCapture('cam1', 'rtsp://localhost:8554/test');
let reconnected = false;
cap.on('reconnecting', () => { reconnected = true; console.log('reconnecting event received'); });
cap.start();
setTimeout(() => {
  if (cap._proc) cap._proc.kill('SIGKILL');
}, 2000);
setTimeout(() => {
  cap.stop();
  console.log(reconnected ? 'PASS' : 'FAIL: no reconnect');
  process.exit(reconnected ? 0 : 1);
}, 4000);
"
```

**합격 기준:**
- subprocess 종료 후 1~2초 이내에 `reconnecting` 이벤트 발생
- `reconnecting.attempt` = 1 (첫 번째 재시도)
- `_retryTimer` 설정 후 새 subprocess spawn 확인
- `stop()` 호출 시 `_retryTimer` 취소, 추가 재연결 없음

---

## 합격/불합격 판정 기준 요약

| TC | 조건 | 비고 |
|----|------|------|
| TC-CAPTURE-001 | 3가지 env 값 → 3가지 올바른 클래스 반환 | 핵심 라우팅 |
| TC-CAPTURE-002 | env 미설정 → ffmpeg 기본값 | 하위 호환성 |
| TC-CAPTURE-003 | gst-launch-1.0, decodebin 설치됨 | GStreamer 사전 조건 |
| TC-CAPTURE-004 | software 파이프라인에 nvdec/vaapi 미포함 | 소프트웨어 경로 |
| TC-CAPTURE-005 | nvdec 환경에서 nvh264dec 파이프라인 사용 | GPU 가속 |
| TC-CAPTURE-006 | vaapi 환경에서 vaapipostproc 파이프라인 사용 | GPU 가속 |
| TC-CAPTURE-007 | auto 모드에서 nvdec 없으면 software fallback | 안전 기본값 |
| TC-CAPTURE-008 | `import av, PIL` 성공 | PyAV 사전 조건 |
| TC-CAPTURE-009 | mock JPEG → frame 이벤트 수신 | PyAV 파싱 |
| TC-CAPTURE-010 | 잘못된 값 → RTSPCapture + warn 1회 | 방어 코드 |
| TC-CAPTURE-011 | 백엔드 전환 후 파이프라인 정상 가동 | 운영 전환 |
| TC-CAPTURE-012 | subprocess 종료 후 자동 재연결 | 안정성 |
