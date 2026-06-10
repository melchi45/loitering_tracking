import { DashboardDetectionPanel } from './DashboardDetectionPanel';

interface Props {
  onClose?: () => void;
}

/**
 * Full-screen overlay that surfaces the real-time DashboardDetectionPanel
 * inside the AnalysisServerDashboard.  Opened by the "감지 이벤트 (누적)"
 * stat card so operators can inspect live person/object detections,
 * snapshot thumbnails, Person Trails, and Cross-Camera Re-ID events without
 * leaving the analysis dashboard.
 */
export default function AnalysisLivePanel({ onClose }: Props) {
  return (
    <div className="relative flex flex-col h-full bg-gray-950 overflow-hidden">
      {onClose && (
        <button
          onClick={onClose}
          title="닫기"
          className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded-full bg-gray-800/90 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors shadow"
        >
          ✕
        </button>
      )}
      <DashboardDetectionPanel />
    </div>
  );
}
