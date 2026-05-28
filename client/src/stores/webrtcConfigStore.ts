import { create } from 'zustand';

export interface TurnServer {
  url:        string;
  username:   string;
  credential: string;
}

export interface WebRTCConfig {
  enabled:  boolean;
  stunUrls: string[];
  turns:    TurnServer[];
  // Legacy fields kept for migration only — do not use directly
  turnUrl?:        string;
  turnUsername?:   string;
  turnCredential?: string;
}

const STORAGE_KEY = 'lts-webrtc-config';

const DEFAULT_CONFIG: WebRTCConfig = {
  enabled:  false,
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  turns: [
    { url: 'turn:192.168.214.3:3478',  username: 'turn_user1', credential: 'test1234' },
    { url: 'turn:55.101.57.105:3478',  username: 'turn_user1', credential: 'test1234' },
  ],
};

function load(): WebRTCConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // ── Migrate legacy single-TURN format ──────────────────────────────
      if (!parsed.turns && parsed.turnUrl) {
        parsed.turns = [{ url: parsed.turnUrl, username: parsed.turnUsername ?? '', credential: parsed.turnCredential ?? '' }];
        delete parsed.turnUrl; delete parsed.turnUsername; delete parsed.turnCredential;
      }
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {}
  return DEFAULT_CONFIG;
}

interface WebRTCConfigStore extends WebRTCConfig {
  setConfig: (cfg: WebRTCConfig) => void;
  getIceServers: () => RTCIceServer[];
}

export const useWebRTCConfigStore = create<WebRTCConfigStore>((set, get) => ({
  ...load(),

  setConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    set(cfg);
    // Persist to server (DB) so config survives browser cache clears and
    // stays consistent across multiple browser sessions / devices.
    fetch('/api/settings/webrtcConfig', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    }).catch(() => {});
  },

  getIceServers() {
    const { stunUrls, turns } = get();
    const servers: RTCIceServer[] = stunUrls
      .map((u) => u.trim())
      .filter(Boolean)
      .map((urls) => ({ urls }));

    for (const t of (turns ?? [])) {
      const url = t.url.trim();
      if (url) servers.push({ urls: url, username: t.username, credential: t.credential });
    }
    return servers;
  },
}));
