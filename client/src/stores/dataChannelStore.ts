import { create } from 'zustand';

export interface AppRtpMessage {
  /** Originating camera ID */
  cameraId:  string;
  /** RTP payload type (96–127) */
  pt:        number;
  /** RTP timestamp from camera */
  timestamp: number;
  /** RTP sequence number */
  seq:       number;
  /** Base64-encoded raw payload bytes */
  payload:   string;
  /** Wall-clock time the message was received in the browser */
  receivedAt: number;
}

const HISTORY_MAX     = 100;   // max entries kept per camera
const HISTORY_THROTTLE_MS = 200; // max 5 history updates per second per camera

interface DataChannelStore {
  /** Latest App RTP message per cameraId */
  messages: Record<string, AppRtpMessage>;
  /** Total received count per cameraId */
  counts:   Record<string, number>;
  /** Bounded history per cameraId — max HISTORY_MAX entries, throttled at 5/s */
  history:  Record<string, AppRtpMessage[]>;
  /** Internal: last history-push timestamp per cameraId */
  _lastHistoryTs: Record<string, number>;
  /** Internal: last seq processed per cameraId — prevents double-counting when
   *  both DataChannel and Socket.IO deliver the same packet */
  _lastSeqs: Record<string, number>;

  pushMessage: (msg: Omit<AppRtpMessage, 'receivedAt'>) => void;
  clearCamera: (cameraId: string) => void;
}

export const useDataChannelStore = create<DataChannelStore>((set) => ({
  messages:      {},
  counts:        {},
  history:       {},
  _lastHistoryTs: {},
  _lastSeqs:     {},

  pushMessage(msg) {
    const now = Date.now();
    const full: AppRtpMessage = { ...msg, receivedAt: now };
    set(s => {
      // Deduplicate: skip if we've already processed this seq for this camera.
      // Both the mediasoup DataChannel and Socket.IO paths deliver the same
      // packets; whichever arrives first wins, the second is dropped here.
      const lastSeq = s._lastSeqs[msg.cameraId] ?? -1;
      if (msg.seq <= lastSeq) return s;

      const lastTs       = s._lastHistoryTs[msg.cameraId] ?? 0;
      const addToHistory = (now - lastTs) >= HISTORY_THROTTLE_MS;

      let history        = s.history;
      let _lastHistoryTs = s._lastHistoryTs;
      if (addToHistory) {
        const prev = s.history[msg.cameraId] ?? [];
        const next = prev.length >= HISTORY_MAX
          ? [...prev.slice(1), full]
          : [...prev, full];
        history        = { ...s.history,       [msg.cameraId]: next };
        _lastHistoryTs = { ...s._lastHistoryTs, [msg.cameraId]: now };
      }

      return {
        messages:  { ...s.messages,  [msg.cameraId]: full },
        counts:    { ...s.counts,    [msg.cameraId]: (s.counts[msg.cameraId] ?? 0) + 1 },
        _lastSeqs: { ...s._lastSeqs, [msg.cameraId]: msg.seq },
        history,
        _lastHistoryTs,
      };
    });
  },

  clearCamera(cameraId) {
    set(s => {
      const messages       = { ...s.messages };
      const counts         = { ...s.counts };
      const history        = { ...s.history };
      const _lastHistoryTs = { ...s._lastHistoryTs };
      const _lastSeqs      = { ...s._lastSeqs };
      delete messages[cameraId];
      delete counts[cameraId];
      delete history[cameraId];
      delete _lastHistoryTs[cameraId];
      delete _lastSeqs[cameraId];
      return { messages, counts, history, _lastHistoryTs, _lastSeqs };
    });
  },
}));
