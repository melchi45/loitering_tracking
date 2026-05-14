import React from 'react';
import { useAlertStore } from '../stores/alertStore';
import { useCameraStore } from '../stores/cameraStore';
import type { Alert } from '../types';

const MAX_VISIBLE = 20;

function relativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

function AlertRow({ alert }: { alert: Alert }) {
  const cameras = useCameraStore((s) => s.cameras);
  const acknowledgeAlert = useAlertStore((s) => s.acknowledgeAlert);

  const camera = cameras.find((c) => c.id === alert.cameraId);
  const cameraName = camera?.name ?? alert.cameraId;

  const handleAck = async () => {
    try {
      await fetch(`/api/alerts/${alert.id}/acknowledge`, { method: 'POST' });
    } catch {
      // If the API call fails, still acknowledge locally
    }
    acknowledgeAlert(alert.id);
  };

  return (
    <div
      className={`flex items-start gap-2 p-2 rounded text-xs border ${
        alert.acknowledged
          ? 'bg-gray-800 border-gray-700 opacity-60'
          : 'bg-gray-800 border-red-900/40 bg-red-950/20'
      }`}
    >
      {/* Warning icon */}
      <div className={`mt-0.5 flex-shrink-0 ${alert.acknowledged ? 'text-gray-500' : 'text-red-400'}`}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1">
          <span className="font-semibold text-white truncate">
            {cameraName}
          </span>
          <span className="text-gray-400 flex-shrink-0">{relativeTime(alert.timestamp)}</span>
        </div>
        <div className="text-gray-300 mt-0.5">
          Obj #{alert.objectId}
          {alert.zone && <span className="text-gray-400"> · {alert.zone}</span>}
        </div>
        <div className="text-yellow-400 mt-0.5">
          Dwell: {alert.dwellTime.toFixed(1)}s
        </div>
      </div>

      {/* Ack button */}
      {!alert.acknowledged && (
        <button
          onClick={handleAck}
          className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-bold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded border border-gray-600 transition-colors"
        >
          Ack
        </button>
      )}
    </div>
  );
}

export default function AlertPanel() {
  const alerts = useAlertStore((s) => s.alerts);
  const clearAlerts = useAlertStore((s) => s.clearAlerts);

  const visible = alerts.slice(0, MAX_VISIBLE);
  const unacknowledgedCount = alerts.filter((a) => !a.acknowledged).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">Alerts</span>
          {unacknowledgedCount > 0 && (
            <span className="text-[10px] font-bold bg-red-600 text-white rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
              {unacknowledgedCount}
            </span>
          )}
        </div>
        {alerts.length > 0 && (
          <button
            onClick={clearAlerts}
            className="text-[11px] text-gray-400 hover:text-red-400 transition-colors"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Alert list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 text-xs">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-8 h-8 mb-2 opacity-40"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>No alerts</span>
          </div>
        ) : (
          visible.map((alert) => <AlertRow key={alert.id} alert={alert} />)
        )}
      </div>
    </div>
  );
}
