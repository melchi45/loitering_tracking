'use strict';

/**
 * systemMetrics.js — CPU / RAM / GPU 사용률 주기적 수집
 *
 * CPU: os.cpus() 델타 방식 (2초 간격)
 * RAM: os.totalmem / os.freemem
 * GPU: nvidia-smi 쿼리 (NVIDIA), 실패 시 null
 */

const os   = require('os');
const { exec } = require('child_process');

let _lastCpuTimes = null;
let _cpuUsagePct  = null;    // number 0-100 or null (first tick 전)
let _gpuInfo      = null;    // null | Array<{index,utilization,memUsed,memTotal}>
let _gpuAvailable = true;    // nvidia-smi 실패 시 false로 전환

// ── CPU 샘플 ─────────────────────────────────────────────────────────────────
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
function _sampleGpu() {
  if (!_gpuAvailable) return;
  exec(
    'nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
    { timeout: 3000 },
    (err, stdout) => {
      if (err) {
        _gpuAvailable = false;
        _gpuInfo = null;
        return;
      }
      try {
        _gpuInfo = stdout.trim().split('\n')
          .filter(Boolean)
          .map(line => {
            const parts = line.split(',').map(s => parseInt(s.trim(), 10));
            return {
              index:       parts[0],
              utilization: parts[1],  // %
              memUsed:     parts[2],  // MiB
              memTotal:    parts[3],  // MiB
            };
          });
      } catch {
        _gpuInfo = null;
      }
    }
  );
}

// 기동 시 즉시 베이스라인 수집 후 2초 간격 폴링
_sampleCpu();
_sampleGpu();
const _timer = setInterval(() => { _sampleCpu(); _sampleGpu(); }, 2000);
_timer.unref(); // 이 타이머만 남아 프로세스가 종료되지 않도록

// ── 공개 API ──────────────────────────────────────────────────────────────────
function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const proc     = process.memoryUsage();

  return {
    cpu: {
      usagePct: _cpuUsagePct,          // null | 0-100
      cores:    os.cpus().length,
    },
    memory: {
      totalBytes:  totalMem,
      freeBytes:   freeMem,
      usedPct:     Math.round((1 - freeMem / totalMem) * 100),
      processRss:  proc.rss,
      processHeap: proc.heapUsed,
    },
    gpu: _gpuInfo,  // null (없음/에러) | Array<{index,utilization,memUsed,memTotal}>
  };
}

module.exports = { getSystemMetrics };
