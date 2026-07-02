import { create } from 'zustand';

/**
 * Server-configured MAX_CHANNEL_NUM (server/.env), read once from GET /health
 * on app mount (see App.tsx) — mirrors how serverMode itself is handled.
 * See docs/design/Design_Channel_Slot.md §5.8.
 */
interface ChannelConfigStore {
  maxChannelNum: number;
  setMaxChannelNum: (n: number) => void;
}

const DEFAULT_MAX_CHANNEL_NUM = 512;

export const useChannelConfigStore = create<ChannelConfigStore>((set) => ({
  maxChannelNum: DEFAULT_MAX_CHANNEL_NUM,
  setMaxChannelNum: (n) => set({ maxChannelNum: n > 0 ? n : DEFAULT_MAX_CHANNEL_NUM }),
}));
