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

interface DataChannelStore {
  /** Latest App RTP messages keyed by cameraId — one entry per camera */
  messages: Record<string, AppRtpMessage>;
  /** Total received count per cameraId */
  counts:   Record<string, number>;
  pushMessage: (msg: Omit<AppRtpMessage, 'receivedAt'>) => void;
  clearCamera: (cameraId: string) => void;
}

export const useDataChannelStore = create<DataChannelStore>((set) => ({
  messages: {},
  counts:   {},

  pushMessage(msg) {
    const full: AppRtpMessage = { ...msg, receivedAt: Date.now() };
    set(s => ({
      messages: { ...s.messages, [msg.cameraId]: full },
      counts:   { ...s.counts,   [msg.cameraId]: (s.counts[msg.cameraId] ?? 0) + 1 },
    }));
  },

  clearCamera(cameraId) {
    set(s => {
      const messages = { ...s.messages };
      const counts   = { ...s.counts };
      delete messages[cameraId];
      delete counts[cameraId];
      return { messages, counts };
    });
  },
}));
