'use strict';
/**
 * RTSP Capture Backend — Unit Tests
 *
 * TC: TC-LTS-CAPTURE-002
 *   CaptureFactory   (TC-CAPTURE-001, 002, 010)
 *   GStreamerCapture (TC-CAPTURE-003~007, 012)
 *   PyAVCapture      (TC-CAPTURE-008, 009, 012)
 *
 * All tests run without a real camera.
 * child_process is mocked via jest.mock() (hoisted) so that module-level
 * constants (GST_AVAILABLE, PYAV_AVAILABLE, HW_DECODER) are controlled in
 * each test through jest.isolateModules() + env-var overrides.
 *
 * Run: npx jest test/api/capture-backend.test.js --runInBand --forceExit
 */

const { EventEmitter } = require('events');
const path             = require('path');

// ── Module paths ──────────────────────────────────────────────────────────────

const FACTORY_PATH = path.resolve(__dirname, '../../server/src/services/captureFactory.js');
const GST_PATH     = path.resolve(__dirname, '../../server/src/services/gstreamerCapture.js');
const PYAV_PATH    = path.resolve(__dirname, '../../server/src/services/pyavCapture.js');
const RTSP_PATH    = path.resolve(__dirname, '../../server/src/services/rtspCapture.js');

// ── child_process mock (hoisted by Jest) ─────────────────────────────────────

jest.mock('child_process', () => {
  const EventEmitter = require('events').EventEmitter;

  // Mutable factory so individual tests can swap behaviour
  let _spawnSyncImpl = () => ({ status: 0, stdout: 'ok\n', stderr: '' });
  let _spawnImpl     = null; // set to null so default creates a fresh proc each time

  function makeMockProc() {
    const proc   = new EventEmitter();
    proc.stdout  = new EventEmitter();
    proc.stderr  = new EventEmitter();
    proc.killed  = false;
    proc.kill    = jest.fn((sig) => {
      proc.killed = true;
      setImmediate(() => proc.emit('close', null, sig || 'SIGKILL'));
    });
    proc.exitWithCode = (code = 0) => setImmediate(() => proc.emit('close', code, null));
    return proc;
  }

  const mock = {
    spawnSync: jest.fn((...a) => _spawnSyncImpl(...a)),
    spawn:     jest.fn((...a) => (_spawnImpl ? _spawnImpl(...a) : makeMockProc())),
    // ── Test-facing helpers ──────────────────────────────────────────────────
    __setSpawnSyncImpl: (fn) => { _spawnSyncImpl = fn; },
    __setSpawnImpl:     (fn) => { _spawnImpl     = fn; },
    __clearSpawnImpl:   ()   => { _spawnImpl     = null; },
    __resetImpls:       ()   => {
      _spawnSyncImpl = () => ({ status: 0, stdout: 'ok\n', stderr: '' });
      _spawnImpl     = null;
    },
    __makeMockProc: makeMockProc,
  };
  return mock;
});

// ── Grab mocked child_process after jest.mock() is set up ────────────────────
const cp = require('child_process');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a valid minimal JPEG buffer: SOI + payload + EOI. */
function makeJpeg(payloadSize = 20) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(payloadSize, 0xab),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * Load a service module in isolation with given env variables.
 * Uses jest.isolateModules() so module-level constants are re-evaluated.
 * Returns the loaded module.
 */
function isolatedRequire(modulePath, envPatch = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(envPatch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  let mod;
  jest.isolateModules(() => {
    mod = require(modulePath);
  });

  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return mod;
}

// ── Global test setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  cp.__resetImpls();
  cp.spawnSync.mockClear();
  cp.spawn.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════════
// CaptureFactory
// ════════════════════════════════════════════════════════════════════════════════

describe('CaptureFactory', () => {
  // NOTE: isolatedRequire() loads modules in a separate registry context.
  // Comparing instances with toBeInstanceOf() across two isolated contexts
  // always fails even when constructor names match, because the class objects
  // are different references.  We therefore check constructor.name instead,
  // which is the correct approach when modules are hot-reloaded per test.

  it('CAPTURE_BACKEND=ffmpeg returns RTSPCapture instance (TC-CAPTURE-001)', () => {
    const { createCapture } = isolatedRequire(FACTORY_PATH, { CAPTURE_BACKEND: 'ffmpeg' });
    expect(createCapture('c1', 'rtsp://x').constructor.name).toBe('RTSPCapture');
  });

  it('CAPTURE_BACKEND unset defaults to ffmpeg (TC-CAPTURE-002)', () => {
    const { createCapture, CAPTURE_BACKEND } = isolatedRequire(FACTORY_PATH, { CAPTURE_BACKEND: undefined });
    expect(CAPTURE_BACKEND).toBe('ffmpeg');
    expect(createCapture('c1', 'rtsp://x').constructor.name).toBe('RTSPCapture');
  });

  it('CAPTURE_BACKEND=gstreamer returns GStreamerCapture instance (TC-CAPTURE-001)', () => {
    cp.__setSpawnSyncImpl((cmd) => {
      if (cmd === 'gst-launch-1.0') return { status: 0, stdout: 'GStreamer 1.20\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const { createCapture } = isolatedRequire(FACTORY_PATH, { CAPTURE_BACKEND: 'gstreamer' });
    expect(createCapture('c1', 'rtsp://x').constructor.name).toBe('GStreamerCapture');
  });

  it('CAPTURE_BACKEND=pyav returns PyAVCapture instance (TC-CAPTURE-001)', () => {
    cp.__setSpawnSyncImpl(() => ({ status: 0, stdout: 'ok\n', stderr: '' }));
    const { createCapture } = isolatedRequire(FACTORY_PATH, { CAPTURE_BACKEND: 'pyav' });
    expect(createCapture('c1', 'rtsp://x').constructor.name).toBe('PyAVCapture');
  });

  it('unknown CAPTURE_BACKEND falls back to RTSPCapture with console.warn once (TC-CAPTURE-010)', () => {
    const warnSpy = jest.spyOn(console, 'warn');
    const { createCapture } = isolatedRequire(FACTORY_PATH, { CAPTURE_BACKEND: 'bad_backend' });

    const cap1 = createCapture('c1', 'rtsp://x');
    const cap2 = createCapture('c2', 'rtsp://x');

    expect(cap1.constructor.name).toBe('RTSPCapture');
    expect(cap2.constructor.name).toBe('RTSPCapture');

    const unknownWarns = warnSpy.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('Unknown CAPTURE_BACKEND'),
    );
    expect(unknownWarns).toHaveLength(1);          // _warnedOnce flag
    expect(unknownWarns[0][0]).toContain('bad_backend');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// GStreamerCapture
// ════════════════════════════════════════════════════════════════════════════════

describe('GStreamerCapture', () => {
  /** Load GStreamerCapture with controlled spawnSync behaviour and env vars. */
  function loadGST(envPatch = {}, spawnSyncImpl = null) {
    cp.__setSpawnSyncImpl(spawnSyncImpl || ((cmd) => {
      if (cmd === 'gst-launch-1.0') return { status: 0, stdout: 'GStreamer 1.20\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' }; // no hw plugins
    }));
    cp.spawnSync.mockClear();
    cp.spawn.mockClear();
    return isolatedRequire(GST_PATH, envPatch);
  }

  it('start() emits error when gst-launch-1.0 is not installed (TC-CAPTURE-003)', (done) => {
    const GSTClass = loadGST({}, () => ({ status: 1, stdout: '', stderr: '' }));
    const cap = new GSTClass('c1', 'rtsp://x');
    cap.on('error', (err) => {
      expect(err.message).toMatch(/gst-launch-1\.0 not found/);
      done();
    });
    cap.start();
  });

  it('emits frame event when stdout yields a valid JPEG (TC-CAPTURE-004/009)', (done) => {
    const GSTClass = loadGST();
    const proc     = cp.__makeMockProc();
    cp.spawn.mockImplementation(() => proc);

    const cap = new GSTClass('c1', 'rtsp://x');
    cap.on('error', done);
    cap.on('frame', (buf) => {
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
      cap.stop();
      done();
    });
    cap.start();
    setImmediate(() => proc.stdout.emit('data', makeJpeg(50)));
  });

  it('emits frame event when JPEG spans two data chunks (split boundary)', (done) => {
    const GSTClass = loadGST();
    const proc     = cp.__makeMockProc();
    cp.spawn.mockImplementation(() => proc);

    const cap = new GSTClass('c1', 'rtsp://x');
    cap.on('error', done);
    cap.on('frame', (buf) => {
      expect(buf.length).toBeGreaterThan(4);
      cap.stop();
      done();
    });
    cap.start();
    setImmediate(() => {
      const full = makeJpeg(40);
      const mid  = Math.floor(full.length / 2);
      proc.stdout.emit('data', full.slice(0, mid));
      proc.stdout.emit('data', full.slice(mid));
    });
  });

  it('stop() cancels reconnect timer — no re-spawn after stop (TC-CAPTURE-012)', (done) => {
    const GSTClass = loadGST();
    const proc     = cp.__makeMockProc();
    cp.spawn.mockImplementation(() => proc);

    const cap = new GSTClass('c1', 'rtsp://x');
    cap.on('error', () => {});
    cap.start();

    setImmediate(() => {
      cap._scheduleRetry();
      cap.stop();
      setTimeout(() => {
        // spawn called once (initial start); retry was cancelled by stop()
        expect(cp.spawn).toHaveBeenCalledTimes(1);
        done();
      }, 1500);
    });
  });

  it('_buildArgs() produces nvdec pipeline when HW_DECODER=nvdec (TC-CAPTURE-005)', () => {
    const GSTClass = loadGST({ GSTREAMER_HW_ACCEL: 'nvdec' }, (cmd, args) => {
      if (cmd === 'gst-launch-1.0') return { status: 0, stdout: 'GStreamer 1.20\n', stderr: '' };
      if (cmd === 'gst-inspect-1.0' && args[0] === 'nvdec')
        return { status: 0, stdout: 'Factory Details\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const args = new GSTClass('c1', 'rtsp://x')._buildArgs().join(' ');
    expect(args).toContain('nvh264dec');
    expect(args).not.toContain('vaapipostproc');
  });

  it('_buildArgs() produces vaapi pipeline when HW_DECODER=vaapi (TC-CAPTURE-006)', () => {
    const GSTClass = loadGST({ GSTREAMER_HW_ACCEL: 'vaapi' }, (cmd, args) => {
      if (cmd === 'gst-launch-1.0') return { status: 0, stdout: 'GStreamer 1.20\n', stderr: '' };
      if (cmd === 'gst-inspect-1.0' && args[0] === 'vaapi')
        return { status: 0, stdout: 'Factory Details\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    const args = new GSTClass('c1', 'rtsp://x')._buildArgs().join(' ');
    expect(args).toContain('vaapipostproc');
    expect(args).not.toContain('nvh264dec');
  });

  it('_buildArgs() falls back to software pipeline when no hw plugins found (TC-CAPTURE-007)', () => {
    const GSTClass = loadGST({ GSTREAMER_HW_ACCEL: 'auto' }); // default: all inspect fail
    const args     = new GSTClass('c1', 'rtsp://x')._buildArgs().join(' ');
    expect(args).toContain('decodebin');
    expect(args).not.toContain('nvh264dec');
    expect(args).not.toContain('vaapipostproc');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PyAVCapture
// ════════════════════════════════════════════════════════════════════════════════

describe('PyAVCapture', () => {
  /** Load PyAVCapture with controlled spawnSync behaviour and env vars. */
  function loadPyAV(envPatch = {}, spawnSyncImpl = null) {
    cp.__setSpawnSyncImpl(spawnSyncImpl || (() => ({ status: 0, stdout: 'ok\n', stderr: '' })));
    cp.spawnSync.mockClear();
    cp.spawn.mockClear();
    return isolatedRequire(PYAV_PATH, envPatch);
  }

  it('start() emits error when Python/PyAV is not available (TC-CAPTURE-008)', (done) => {
    const PyAVClass = loadPyAV({}, () => ({ status: 1, stdout: '', stderr: 'No module named av' }));
    const cap = new PyAVClass('c1', 'rtsp://x');
    cap.on('error', (err) => {
      expect(err.message).toMatch(/Python\/PyAV not available/);
      done();
    });
    cap.start();
  });

  it('emits frame event when stdout contains a valid JPEG (TC-CAPTURE-009)', (done) => {
    const PyAVClass = loadPyAV();
    const proc      = cp.__makeMockProc();
    cp.spawn.mockImplementation(() => proc);

    const cap = new PyAVClass('c1', 'rtsp://x');
    cap.on('error', done);
    cap.on('frame', (buf) => {
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
      expect(buf[buf.length - 2]).toBe(0xff);
      expect(buf[buf.length - 1]).toBe(0xd9);
      cap.stop();
      done();
    });
    cap.start();
    setImmediate(() => proc.stdout.emit('data', makeJpeg(60)));
  });

  it('emits multiple frame events for multiple JPEGs in a single chunk', (done) => {
    const PyAVClass = loadPyAV();
    const proc      = cp.__makeMockProc();
    cp.spawn.mockImplementation(() => proc);

    const frames = [];
    const cap    = new PyAVClass('c1', 'rtsp://x');
    cap.on('error', done);
    cap.on('frame', (buf) => {
      frames.push(buf);
      if (frames.length === 3) { cap.stop(); done(); }
    });
    cap.start();
    setImmediate(() => {
      proc.stdout.emit('data', Buffer.concat([makeJpeg(10), makeJpeg(20), makeJpeg(30)]));
    });
  });

  it('stop() cancels reconnect timer — no re-spawn after stop (TC-CAPTURE-012)', (done) => {
    const PyAVClass = loadPyAV();
    const proc      = cp.__makeMockProc();
    cp.spawn.mockImplementation(() => proc);

    const cap = new PyAVClass('c1', 'rtsp://x');
    cap.on('error', () => {});
    cap.start();

    setImmediate(() => {
      cap._scheduleRetry();
      cap.stop();
      setTimeout(() => {
        expect(cp.spawn).toHaveBeenCalledTimes(1);
        done();
      }, 1500);
    });
  });

  it('reconnecting event fires with correct attempt count after subprocess exit (TC-CAPTURE-012)', (done) => {
    const PyAVClass = loadPyAV();
    const proc      = cp.__makeMockProc();
    cp.spawn.mockImplementation(() => proc);

    const cap = new PyAVClass('c1', 'rtsp://x');
    cap.on('reconnecting', (info) => {
      expect(info.attempt).toBe(1);
      expect(info.cameraId).toBe('c1');
      expect(typeof info.delay).toBe('number');
      cap.stop();
      done();
    });
    cap.on('error', done);
    cap.start();

    setImmediate(() => proc.exitWithCode(1));
  });
});
