'use strict';

/**
 * systemMetrics.js — CPU / RAM / GPU / Disk 사용률 주기적 수집
 *
 * CPU: os.cpus() 델타 방식 (2초 간격)
 * RAM: os.totalmem / os.freemem
 * GPU: nvidia-smi 쿼리 (NVIDIA), 실패 시 null
 * Disk I/O: /proc/diskstats 델타 (Linux), 실패 시 null
 * Storage: df -k (STORAGE_PATH 마운트 포인트), 30초 간격
 */

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ── CPU 샘플 ─────────────────────────────────────────────────────────────────
let _lastCpuTimes = null;
let _cpuUsagePct  = null;

function _sampleCpu() {
  const cpus    = os.cpus();
  const current = cpus.reduce((acc, cpu) => {
    for (const [k, v] of Object.entries(cpu.times)) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});

  if (_lastCpuTimes) {
    const dIdle  = current.idle - _lastCpuTimes.idle;
    const dTotal = Object.keys(current).reduce(
      (s, k) => s + current[k] - (_lastCpuTimes[k] || 0), 0
    );
    _cpuUsagePct = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
  }
  _lastCpuTimes = current;
}

// ── GPU 샘플 (NVIDIA) ─────────────────────────────────────────────────────────
let _gpuInfo      = null;
let _gpuAvailable = true;

function _sampleGpu() {
  if (!_gpuAvailable) return;
  exec(
    'nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
    { timeout: 3000 },
    (err, stdout) => {
      if (err) { _gpuAvailable = false; _gpuInfo = null; return; }
      try {
        _gpuInfo = stdout.trim().split('\n').filter(Boolean).map(line => {
          const p = line.split(',').map(s => parseInt(s.trim(), 10));
          return { index: p[0], utilization: p[1], memUsed: p[2], memTotal: p[3] };
        });
      } catch { _gpuInfo = null; }
    }
  );
}

// ── Disk I/O (/proc/diskstats, Linux only) ────────────────────────────────────
let _diskIo         = null;
let _prevDiskStats  = null;
let _prevDiskAt     = null;

function _parseDiskstats() {
  try {
    const lines = fs.readFileSync('/proc/diskstats', 'utf8').split('\n');
    const stats = {};
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 14) continue;
      const name = p[2];
      // Keep only physical block devices (sda, nvme0n1, vda, xvda …)
      // Skip loops, ram, sr, dm-, and numbered partitions (sda1, nvme0n1p1)
      if (/^(loop|ram|sr|fd|dm-)/.test(name)) continue;
      if (/\d$/.test(name) && !/nvme\d+n\d+$/.test(name) && !/mmcblk\d+$/.test(name)) continue;
      stats[name] = {
        sectorsRead:    parseInt(p[5]),
        sectorsWritten: parseInt(p[9]),
      };
    }
    return stats;
  } catch { return null; }
}

function _sampleDiskIo() {
  const now   = Date.now();
  const stats = _parseDiskstats();
  if (!stats) { _diskIo = null; _prevDiskStats = null; return; }

  if (_prevDiskStats && _prevDiskAt) {
    const dt = (now - _prevDiskAt) / 1000;
    if (dt > 0) {
      let readBps = 0, writeBps = 0;
      for (const [name, curr] of Object.entries(stats)) {
        const prev = _prevDiskStats[name];
        if (!prev) continue;
        readBps  += (curr.sectorsRead    - prev.sectorsRead)    * 512 / dt;
        writeBps += (curr.sectorsWritten - prev.sectorsWritten) * 512 / dt;
      }
      _diskIo = { readBps: Math.round(Math.max(0, readBps)), writeBps: Math.round(Math.max(0, writeBps)) };
    }
  }
  _prevDiskStats = stats;
  _prevDiskAt    = now;
}

// ── Storage capacity (df, sampled every 30 s) ─────────────────────────────────
let _storageInfo       = null;
let _lastStorageSample = 0;

function _sampleStorageIfNeeded() {
  const now = Date.now();
  if (now - _lastStorageSample < 30_000) return;
  _lastStorageSample = now;

  const storagePath = process.env.STORAGE_PATH
    ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
    : path.resolve(__dirname, '..', '..', 'storage');

  exec(`df -k "${storagePath}" 2>/dev/null`, { timeout: 3000 }, (err, stdout) => {
    if (err) { _storageInfo = null; return; }
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) { _storageInfo = null; return; }
    const p = lines[lines.length - 1].split(/\s+/);
    if (p.length < 5) { _storageInfo = null; return; }
    const usedPct = parseInt(p[4]);
    _storageInfo = {
      totalBytes: parseInt(p[1]) * 1024,
      usedBytes:  parseInt(p[2]) * 1024,
      freeBytes:  parseInt(p[3]) * 1024,
      usedPct:    isNaN(usedPct) ? null : usedPct,
      path:       storagePath,
    };
  });
}

// ── Polling timer (2s CPU+GPU+Disk, storage lazily on getSystemMetrics call) ──
_sampleCpu();
_sampleGpu();
_sampleDiskIo();
_sampleStorageIfNeeded();

const _timer = setInterval(() => {
  _sampleCpu();
  _sampleGpu();
  _sampleDiskIo();
}, 2000);
_timer.unref();

// ── Public API ────────────────────────────────────────────────────────────────
function getSystemMetrics() {
  _sampleStorageIfNeeded(); // lazy 30s refresh

  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const proc     = process.memoryUsage();

  return {
    cpu: {
      usagePct: _cpuUsagePct,   // null | 0-100
      cores:    os.cpus().length,
      model:    os.cpus()[0]?.model?.trim() ?? null,
    },
    memory: {
      totalBytes:  totalMem,
      freeBytes:   freeMem,
      usedPct:     Math.round((1 - freeMem / totalMem) * 100),
      processRss:  proc.rss,
      processHeap: proc.heapUsed,
    },
    gpu: _gpuInfo,
    diskIo:  _diskIo,    // null | { readBps, writeBps }
    storage: _storageInfo, // null | { totalBytes, usedBytes, freeBytes, usedPct, path }
  };
}

module.exports = { getSystemMetrics };
