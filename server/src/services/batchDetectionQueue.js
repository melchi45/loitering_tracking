'use strict';

/**
 * BatchDetectionQueue — 멀티카메라 YOLOv8 배치 추론 큐
 *
 * 여러 카메라에서 동시에 도착하는 JPEG 프레임을 수집해
 * 하나의 batch tensor([B,3,640,640])로 묶어 단일 session.run()을 수행합니다.
 * CUDA: 진짜 GPU 병렬 (CUDA SM 포화율 향상)
 * DML: Command Queue 호출 횟수 감소 → 오버헤드 절감
 * CPU: 동일 (BATCH_MAX_SIZE=1 권장)
 *
 * 환경변수:
 *   BATCH_MAX_SIZE    최대 배치 크기 (기본 4)
 *   BATCH_MAX_WAIT_MS 배치가 차지 않아도 실행하는 최대 대기 시간 ms (기본 33 ≈ 30fps)
 *
 * 동작:
 *   1. enqueue(jpegBuffer) → Promise 반환 (resolve: { detections, frameWidth, frameHeight })
 *   2. 큐에 BATCH_MAX_SIZE 개 누적 또는 BATCH_MAX_WAIT_MS 경과 → _flush() 실행
 *   3. _flush(): detectBatch() 단일 호출 → 결과 분배 → 각 Promise resolve
 *   4. 배치 추론 실패 시 → 해당 배치의 모든 Promise reject (카메라별로 개별 처리)
 */

const BATCH_MAX_SIZE    = parseInt(process.env.BATCH_MAX_SIZE, 10)    || 4;
const BATCH_MAX_WAIT_MS = parseInt(process.env.BATCH_MAX_WAIT_MS, 10) || 33;

class BatchDetectionQueue {
  /**
   * @param {import('./detection')} detector  DetectionService 인스턴스
   */
  constructor(detector) {
    this._detector  = detector;
    this._maxBatch  = Math.max(1, BATCH_MAX_SIZE);
    this._maxWait   = Math.max(1, BATCH_MAX_WAIT_MS);
    this._queue     = [];   // { jpegBuffer, resolve, reject }[]
    this._timer     = null;
    this._flushing  = false;

    // Stats
    this.stats = {
      totalBatches:   0,
      totalFrames:    0,
      avgBatchSize:   0,
      fallbackCount:  0, // single-frame fallback invocations
    };
  }

  /**
   * 프레임을 배치 큐에 추가합니다.
   * @param {Buffer} jpegBuffer
   * @returns {Promise<{ detections: Array, frameWidth: number, frameHeight: number }>}
   */
  enqueue(jpegBuffer) {
    return new Promise((resolve, reject) => {
      this._queue.push({ jpegBuffer, resolve, reject });

      if (this._queue.length >= this._maxBatch) {
        // 배치 크기 충족 → 즉시 플러시 (타이머 캔슬)
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        setImmediate(() => this._flush());
      } else if (!this._timer) {
        // 최대 대기 타이머 시작
        this._timer = setTimeout(() => {
          this._timer = null;
          this._flush();
        }, this._maxWait);
      }
    });
  }

  async _flush() {
    if (this._flushing || this._queue.length === 0) return;
    this._flushing = true;

    const batch = this._queue.splice(0, this._maxBatch);

    try {
      let results;
      if (batch.length === 1 || !this._detector.supportsBatch) {
        // 단일 프레임 또는 배치 미지원 모델 → 기존 단건 추론
        results = await Promise.all(
          batch.map(item => this._detector.detect(item.jpegBuffer))
        );
        if (!this._detector.supportsBatch) this.stats.fallbackCount++;
      } else {
        // 멀티 프레임 배치 추론
        results = await this._detector.detectBatch(batch.map(item => item.jpegBuffer));
      }

      // 통계 업데이트
      this.stats.totalBatches++;
      this.stats.totalFrames += batch.length;
      this.stats.avgBatchSize =
        Math.round((this.stats.totalFrames / this.stats.totalBatches) * 10) / 10;

      batch.forEach((item, i) => item.resolve(results[i]));
    } catch (err) {
      // 배치 실패 시 개별 단건 추론으로 fallback
      this.stats.fallbackCount++;
      await Promise.allSettled(
        batch.map(async (item) => {
          try {
            item.resolve(await this._detector.detect(item.jpegBuffer));
          } catch (e2) {
            item.reject(e2);
          }
        })
      );
    } finally {
      this._flushing = false;

      // 잔여 큐 처리
      if (this._queue.length >= this._maxBatch) {
        setImmediate(() => this._flush());
      } else if (this._queue.length > 0 && !this._timer) {
        this._timer = setTimeout(() => {
          this._timer = null;
          this._flush();
        }, this._maxWait);
      }
    }
  }

  /** 큐를 강제 비우고 대기 중인 모든 항목을 reject합니다. (서버 종료 시) */
  destroy() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const err = new Error('BatchDetectionQueue destroyed');
    for (const item of this._queue) item.reject(err);
    this._queue = [];
  }
}

module.exports = BatchDetectionQueue;
