export type StreamingMode = 'jpeg' | 'webrtc' | 'rtsp-over-websocket';

const MODE_LABELS: Record<StreamingMode, string> = {
  jpeg: 'JPEG',
  webrtc: 'WebRTC',
  'rtsp-over-websocket': 'RTSP-over-WebSocket',
};

const MODE_DESCRIPTIONS: Record<StreamingMode, string> = {
  jpeg: 'Video via JPEG / Socket.IO (default)',
  webrtc: 'Video via WebRTC (H.264 + Audio) — requires SERVER_IP in .env',
  'rtsp-over-websocket': 'Video via RTSP-over-WebSocket',
};

const MODES: StreamingMode[] = ['jpeg', 'webrtc', 'rtsp-over-websocket'];

interface StreamingModeSelectorProps {
  value: StreamingMode;
  onChange: (mode: StreamingMode) => void;
}

/** JPEG/WebRTC/RTSP-over-WebSocket picker — dot indicators, selected mode renders as an enlarged filled circle. */
export function StreamingModeSelector({ value, onChange }: StreamingModeSelectorProps) {
  return (
    <div className="py-2 border-t border-gray-700 mt-1">
      <p className="text-xs text-gray-200 font-medium mb-0.5">Streaming Mode</p>
      <p className="text-[10px] text-gray-500 mb-1.5">{MODE_DESCRIPTIONS[value]}</p>
      <div className="flex items-center justify-between gap-2 h-7">
        <span className="text-[11px] font-medium text-blue-400">{MODE_LABELS[value]}</span>
        <div className="flex items-center justify-center gap-3 h-full px-3 bg-gray-900 border border-gray-600 rounded-full">
          {MODES.map((mode) => {
            const isActive = value === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onChange(mode)}
                title={MODE_LABELS[mode]}
                className="flex items-center justify-center group focus:outline-none"
              >
                <span
                  className={`rounded-full transition-all duration-200 ${
                    isActive
                      ? 'w-2 h-2 bg-blue-500 ring-2 ring-blue-500/25'
                      : 'w-1.5 h-1.5 bg-gray-600 group-hover:bg-gray-400'
                  }`}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
