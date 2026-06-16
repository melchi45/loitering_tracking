import { useEffect, useState, useCallback, useRef } from 'react';
import { getWebRTCSnapshotAsync, type WebRTCPCSummary } from '../clientLogger';
import { useCameraStore } from '../stores/cameraStore';

// ── Types ────────────────────────────────────────────────────────────────────

interface CameraStats {
  total: number;
  byStatus: { streaming: number; stopped: number; error: number; connecting: number };
  byType:   { rtsp: number; youtube: number };
  aiEnabled: number;
}

interface ZoneStats {
  total: number;
  byType:  { MONITOR: number; EXCLUDE: number };
  byCamera: Array<{ cameraId: string; cameraName: string; count: number }>;
}

interface EventStats {
  total: number;
  today: number;
  loitering: number;
  last7days: Array<{ date: string; count: number }>;
}

interface AlertStats {
  total: number;
  unacknowledged: number;
  today: number;
  bySeverity: { HIGH: number; MEDIUM: number; LOW: number };
}

interface FaceStats {
  galleries: number;
  enrolled:  number;
}

interface StatsData {
  generatedAt: string;
  storage:     { mode: string };
  cameras:     CameraStats;
  zones:       ZoneStats;
  events:      EventStats;
  alerts:      AlertStats;
  faces:       FaceStats;
}

interface HourlyHour {
  hour:       number;
  detections: number;
  alerts:     number;
  matches:    number;
  events:     number;
}

interface HourlyData {
  date:    string;
  hours:   HourlyHour[];
  summary: { detections: number; alerts: number; matches: number; events: number };
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: StatsData };

type HourlyFetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; data: HourlyData };

// ── Drill-down types ──────────────────────────────────────────────────────────

type DrillSection = 'hourly' | 'detections' | 'alerts' | 'faceId';

type DrillState =
  | { level: 'overview' }
  | { level: 'section';    section: DrillSection }
  | { level: 'hourList';   section: DrillSection; hour: number }
  | { level: 'itemDetail'; section: DrillSection; hour: number; item: ItemRecord };

type ItemRecord = Record<string, unknown>;

type ItemsFetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; data: Record<string, ItemRecord[]> };

// ── Constants ─────────────────────────────────────────────────────────────────

const SECTION_LABELS: Record<DrillSection, string> = {
  hourly:     'Hourly Breakdown',
  detections: 'Detections',
  alerts:     'Alerts',
  faceId:     'Face ID',
};

const SECTION_TYPES: Record<DrillSection, string[]> = {
  hourly:     ['detections', 'alerts', 'matches', 'events'],
  detections: ['detections'],
  alerts:     ['alerts'],
  faceId:     ['matches'],
};

const TYPE_COLORS: Record<string, string> = {
  detections: '#3b82f6',
  alerts:     '#ef4444',
  matches:    '#06b6d4',
  events:     '#f59e0b',
};

const TYPE_LABELS: Record<string, string> = {
  detections: 'Detection',
  alerts:     'Alert',
  matches:    'Face Match',
  events:     'Event',
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface StatsPanelModalProps {
  open: boolean;
  onClose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDateTime(val: unknown): string {
  if (val === null || val === undefined) return '—';
  const d = typeof val === 'number' ? new Date(val) : new Date(String(val));
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleString();
}

function toLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}

function primaryField(type: string, item: ItemRecord): string {
  if (type === 'detections') return String(item.className || item.class || item.label || '');
  if (type === 'alerts')     return String(item.severity || item.message || '');
  if (type === 'matches')    return String(item.personName || item.personId || '');
  if (type === 'events')     return String(item.type || (item.isLoitering ? 'loitering' : 'motion') || '');
  return '';
}

function itemTimestamp(item: ItemRecord): string {
  const raw = item.timestamp || item.createdAt || item.startTime || item.capturedAt;
  if (!raw) return '';
  return fmtDateTime(raw);
}

// ── SVG Sub-components ────────────────────────────────────────────────────────

function StatChip({ label, value, color = 'text-gray-200' }: {
  label: string; value: number | string; color?: string;
}) {
  return (
    <div className="flex flex-col items-center bg-gray-800 rounded px-3 py-2 min-w-[60px]">
      <span className={`text-xl font-bold leading-none ${color}`}>{value}</span>
      <span className="text-[9px] text-gray-500 mt-0.5 text-center leading-tight">{label}</span>
    </div>
  );
}

function BarChart({ data }: { data: Array<{ date: string; count: number }> }) {
  const W = 400; const H = 80; const gap = 4;
  const n = data.length;
  const barW = (W - gap * (n - 1)) / n;
  const max  = Math.max(...data.map(d => d.count), 1);
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full">
      {data.map((d, i) => {
        const bH = Math.max(2, (d.count / max) * H);
        const x  = i * (barW + gap);
        const isToday = i === n - 1;
        return (
          <g key={d.date}>
            <title>{`${d.date}: ${d.count} events`}</title>
            <rect x={x} y={H - bH} width={barW} height={bH} rx={2} fill={isToday ? '#3b82f6' : '#374151'} />
            <text x={x + barW / 2} y={H + 13} textAnchor="middle" fontSize={8} fill={isToday ? '#93c5fd' : '#6b7280'}>
              {fmtDate(d.date)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function HourlyStackedChart({ hours, activeTypes, onBarClick }: {
  hours: HourlyHour[];
  activeTypes?: string[];
  onBarClick?: (hour: number) => void;
}) {
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);
  const chartW = 560; const chartH = 100; const gap = 2;
  const barW = (chartW - gap * 23) / 24;
  const types = activeTypes ?? ['detections', 'alerts', 'matches', 'events'];

  const maxVal = Math.max(...hours.map(h =>
    types.reduce((s, t) => s + ((h as unknown as Record<string, number>)[t] ?? 0), 0)
  ), 1);

  return (
    <svg viewBox={`0 0 ${chartW} ${chartH + 22}`} className="w-full" aria-label="Hourly activity chart">
      {hours.map(h => {
        const x = h.hour * (barW + gap);
        const isHovered = hoveredHour === h.hour;
        const total = types.reduce((s, t) => s + ((h as unknown as Record<string, number>)[t] ?? 0), 0);
        let yOff = chartH;
        return (
          <g key={h.hour}
            style={{ cursor: onBarClick ? 'pointer' : 'default' }}
            onClick={() => onBarClick?.(h.hour)}
            onMouseEnter={() => setHoveredHour(h.hour)}
            onMouseLeave={() => setHoveredHour(null)}
          >
            <title>{`${String(h.hour).padStart(2, '0')}:00 — ${
              types.map(t => `${TYPE_LABELS[t] ?? t}:${(h as unknown as Record<string,number>)[t] ?? 0}`).join(' ')
            } (${total} total)`}</title>
            {isHovered && <rect x={x - 1} y={0} width={barW + 2} height={chartH} fill="white" fillOpacity={0.06} rx={1} />}
            {types.map(key => {
              const count = (h as unknown as Record<string, number>)[key] ?? 0;
              if (count === 0) return null;
              const bH = Math.max(1, (count / maxVal) * chartH);
              yOff -= bH;
              const y = yOff;
              return <rect key={key} x={x} y={y} width={barW} height={bH} fill={TYPE_COLORS[key] ?? '#888'} />;
            })}
            {h.hour % 4 === 0 && (
              <text x={x + barW / 2} y={chartH + 14} textAnchor="middle" fontSize={8}
                fill={total > 0 ? '#9ca3af' : '#4b5563'}>
                {String(h.hour).padStart(2, '0')}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function SeverityBar({ bySeverity }: { bySeverity: { HIGH: number; MEDIUM: number; LOW: number } }) {
  const total = bySeverity.HIGH + bySeverity.MEDIUM + bySeverity.LOW;
  if (total === 0) return <div className="h-2.5 rounded-full bg-gray-700 w-full" />;
  return (
    <div className="flex h-2.5 rounded-full overflow-hidden w-full"
      title={`HIGH:${bySeverity.HIGH} MEDIUM:${bySeverity.MEDIUM} LOW:${bySeverity.LOW}`}>
      {bySeverity.HIGH   > 0 && <div style={{ width: `${(bySeverity.HIGH   / total) * 100}%` }} className="bg-red-500" />}
      {bySeverity.MEDIUM > 0 && <div style={{ width: `${(bySeverity.MEDIUM / total) * 100}%` }} className="bg-yellow-400" />}
      {bySeverity.LOW    > 0 && <div style={{ width: `${(bySeverity.LOW    / total) * 100}%` }} className="bg-green-500" />}
    </div>
  );
}

// ── BreadcrumbNav ─────────────────────────────────────────────────────────────

function BreadcrumbNav({ drill, selectedDate, onNavigate }: {
  drill: DrillState; selectedDate: string;
  onNavigate: (target: 'overview' | 'section') => void;
}) {
  const crumbs: Array<{ label: string; action?: () => void }> = [
    { label: 'Statistics', action: drill.level !== 'overview' ? () => onNavigate('overview') : undefined },
  ];
  if (drill.level !== 'overview') {
    crumbs.push({
      label: SECTION_LABELS[drill.section],
      action: drill.level !== 'section' ? () => onNavigate('section') : undefined,
    });
  }
  if (drill.level === 'hourList' || drill.level === 'itemDetail') {
    crumbs.push({
      label: `${String(drill.hour).padStart(2, '0')}:00 · ${selectedDate}`,
      action: drill.level === 'itemDetail' ? () => onNavigate('section') : undefined,
    });
  }
  if (drill.level === 'itemDetail') crumbs.push({ label: 'Detail' });

  return (
    <nav className="flex items-center gap-1 min-w-0 flex-wrap" aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-1 min-w-0">
          {i > 0 && <span className="text-gray-600 text-xs">›</span>}
          {c.action ? (
            <button onClick={c.action}
              className="text-blue-400 hover:text-blue-300 text-sm font-medium truncate transition-colors">
              {c.label}
            </button>
          ) : (
            <span className="text-white text-sm font-semibold truncate">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

// ── Overview Card ─────────────────────────────────────────────────────────────

function OverviewCard({ title, icon, drillable, onDoubleClick, children }: {
  title: string; icon: string; drillable?: boolean;
  onDoubleClick?: () => void; children: React.ReactNode;
}) {
  return (
    <div
      className={`bg-gray-900/60 border rounded-xl p-4 flex flex-col gap-3 transition-all
        ${drillable
          ? 'border-gray-600 cursor-pointer hover:border-blue-500 hover:bg-gray-800/60 select-none'
          : 'border-gray-700'}`}
      onDoubleClick={drillable ? onDoubleClick : undefined}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 flex items-center gap-1.5">
          <span>{icon}</span>{title}
        </h3>
        {drillable && <span className="text-[9px] text-gray-600">↵ double-click to explore</span>}
      </div>
      {children}
    </div>
  );
}

// ── WebRTC Stats Card ─────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function WebRTCStatsCard({ refreshTick }: { refreshTick: number }) {
  const [sessions, setSessions] = useState<WebRTCPCSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const cameras = useCameraStore(s => s.cameras);

  useEffect(() => {
    setLoading(true);
    getWebRTCSnapshotAsync()
      .then(setSessions)
      .finally(() => setLoading(false));
  }, [refreshTick]);

  const cameraName = (id: string | null) =>
    cameras.find(c => c.id === id)?.name ?? id?.slice(0, 8) ?? '—';

  const connected = sessions.filter(s => s.connectionState === 'connected').length;
  const failed    = sessions.filter(s =>
    s.connectionState === 'failed' || s.connectionState === 'disconnected').length;

  const stateColor = (s: WebRTCPCSummary) => {
    if (s.connectionState === 'connected')    return 'text-green-400';
    if (s.connectionState === 'connecting')   return 'text-yellow-400';
    if (s.connectionState === 'failed')       return 'text-red-400';
    if (s.connectionState === 'disconnected') return 'text-orange-400';
    return 'text-gray-400';
  };
  const stateDot = (s: WebRTCPCSummary) => {
    if (s.connectionState === 'connected')    return 'bg-green-400';
    if (s.connectionState === 'connecting')   return 'bg-yellow-400 animate-pulse';
    if (s.connectionState === 'failed')       return 'bg-red-500';
    if (s.connectionState === 'disconnected') return 'bg-orange-400';
    return 'bg-gray-500';
  };

  const avgRtt = sessions.length
    ? sessions.filter(s => s.rttMs != null).reduce((a, s) => a + (s.rttMs ?? 0), 0) /
      (sessions.filter(s => s.rttMs != null).length || 1)
    : null;

  return (
    <OverviewCard title="WebRTC" icon="📡">
      {loading ? (
        <p className="text-[10px] text-gray-500 animate-pulse">Collecting stats…</p>
      ) : sessions.length === 0 ? (
        <p className="text-[10px] text-gray-600">No active WebRTC connections</p>
      ) : (
        <>
          {/* Summary chips */}
          <div className="flex gap-2 flex-wrap">
            <StatChip label="Sessions"  value={sessions.length} color="text-white" />
            <StatChip label="Connected" value={connected}        color="text-green-400" />
            {failed > 0 && <StatChip label="Failed" value={failed} color="text-red-400" />}
            {avgRtt != null && (
              <span className="flex flex-col items-center bg-gray-800/60 rounded px-2 py-1">
                <span className="text-[9px] text-gray-400">Avg RTT</span>
                <span className={`text-sm font-bold tabular-nums ${avgRtt < 50 ? 'text-green-400' : avgRtt < 150 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {Math.round(avgRtt)} ms
                </span>
              </span>
            )}
          </div>

          {/* Per-connection rows */}
          <div className="space-y-1.5 mt-1">
            {sessions.map(s => (
              <div key={s.pcId} className="flex items-center gap-2 text-[10px]">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${stateDot(s)}`} />
                <span className="text-gray-300 truncate flex-1 max-w-[120px]" title={s.cameraId ?? ''}>
                  {cameraName(s.cameraId)}
                </span>
                <span className={`font-medium w-20 ${stateColor(s)}`}>
                  {s.connectionState}
                </span>
                {s.rttMs != null && (
                  <span className="text-gray-400 w-12 text-right">
                    {s.rttMs} ms
                  </span>
                )}
                {s.framesPerSecond != null && (
                  <span className="text-blue-300 w-12 text-right">
                    {s.framesPerSecond} fps
                  </span>
                )}
                {s.packetLoss != null && s.packetLoss > 0 && (
                  <span className="text-orange-400 w-12 text-right">
                    {(s.packetLoss * 100).toFixed(1)}% loss
                  </span>
                )}
                {s.bytesReceived > 0 && (
                  <span className="text-gray-500 w-14 text-right">
                    {fmtBytes(s.bytesReceived)}
                  </span>
                )}
                {s.localCandidateType && (
                  <span className={`px-1 rounded text-[8px] ${
                    s.localCandidateType === 'host'  ? 'bg-green-900/60 text-green-300' :
                    s.localCandidateType === 'srflx' ? 'bg-blue-900/60 text-blue-300'  :
                    s.localCandidateType === 'relay' ? 'bg-yellow-900/60 text-yellow-300' :
                    'bg-gray-800 text-gray-400'}`}>
                    {s.localCandidateType}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </OverviewCard>
  );
}

// ── Overview Grid (Level 0) ───────────────────────────────────────────────────

function OverviewGrid({ state, hourlyState, selectedDate, onDrillIn, refreshTick }: {
  state: FetchState; hourlyState: HourlyFetchState;
  selectedDate: string; onDrillIn: (s: DrillSection) => void;
  refreshTick: number;
}) {
  if (state.status === 'loading') {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        <svg className="animate-spin w-6 h-6 mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        <span className="text-sm">Loading statistics…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return <div className="flex items-center justify-center h-64 text-red-400 text-sm">Failed: {state.message}</div>;
  }
  if (state.status !== 'ok') return null;

  const { cameras, zones, events, alerts, faces, storage, generatedAt } = state.data;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-6">

      {/* Hourly Breakdown */}
      <OverviewCard title="Hourly Breakdown" icon="🕐" drillable onDoubleClick={() => onDrillIn('hourly')}>
        {hourlyState.status === 'ok' ? (
          <>
            <div className="flex gap-2 flex-wrap">
              <StatChip label="Det"   value={hourlyState.data.summary.detections} color="text-blue-400" />
              <StatChip label="Alert" value={hourlyState.data.summary.alerts}     color="text-red-400" />
              <StatChip label="Match" value={hourlyState.data.summary.matches}    color="text-cyan-400" />
              <StatChip label="Event" value={hourlyState.data.summary.events}     color="text-amber-400" />
            </div>
            <p className="text-[9px] text-gray-600">{selectedDate}</p>
            {(hourlyState.data.summary.detections + hourlyState.data.summary.alerts +
              hourlyState.data.summary.matches + hourlyState.data.summary.events) > 0
              ? <HourlyStackedChart hours={hourlyState.data.hours} />
              : <p className="text-[10px] text-gray-600 text-center py-2">No activity on this date.</p>
            }
          </>
        ) : (
          <p className="text-[10px] text-gray-600">Loading…</p>
        )}
      </OverviewCard>

      {/* Detections */}
      <OverviewCard title="Detections" icon="📸" drillable onDoubleClick={() => onDrillIn('detections')}>
        <div className="flex gap-2 flex-wrap">
          <StatChip label="Total"     value={events.total}     color="text-white" />
          <StatChip label="Today"     value={events.today}     color="text-blue-400" />
          <StatChip label="Loitering" value={events.loitering} color="text-orange-400" />
        </div>
        {events.last7days.length > 0 && (
          <><p className="text-[9px] text-gray-600 mb-1">Last 7 days</p><BarChart data={events.last7days} /></>
        )}
      </OverviewCard>

      {/* Alerts */}
      <OverviewCard title="Alerts" icon="⚠️" drillable onDoubleClick={() => onDrillIn('alerts')}>
        <div className="flex gap-2 flex-wrap">
          <StatChip label="Total"  value={alerts.total} color="text-white" />
          <StatChip label="Unread" value={alerts.unacknowledged}
            color={alerts.unacknowledged > 0 ? 'text-red-400' : 'text-gray-400'} />
          <StatChip label="Today"  value={alerts.today} color="text-yellow-400" />
        </div>
        <SeverityBar bySeverity={alerts.bySeverity} />
        <div className="flex gap-3 text-[9px] text-gray-400">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />HIGH {alerts.bySeverity.HIGH}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />MED {alerts.bySeverity.MEDIUM}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />LOW {alerts.bySeverity.LOW}</span>
        </div>
      </OverviewCard>

      {/* Face ID */}
      <OverviewCard title="Face ID" icon="🪪" drillable onDoubleClick={() => onDrillIn('faceId')}>
        <div className="flex gap-2 flex-wrap">
          <StatChip label="Galleries" value={faces.galleries} color="text-purple-400" />
          <StatChip label="Enrolled"  value={faces.enrolled}  color="text-white" />
        </div>
        {faces.galleries === 0 && <p className="text-[10px] text-gray-600">No galleries created yet.</p>}
      </OverviewCard>

      {/* Cameras (static) */}
      <OverviewCard title="Cameras" icon="📹">
        <div className="flex gap-2 flex-wrap">
          <StatChip label="Total"     value={cameras.total}              color="text-white" />
          <StatChip label="Streaming" value={cameras.byStatus.streaming} color="text-green-400" />
          <StatChip label="Stopped"   value={cameras.byStatus.stopped}   color="text-gray-400" />
          <StatChip label="Error"     value={cameras.byStatus.error}     color="text-red-400" />
        </div>
        <div className="flex gap-3 text-xs text-gray-400">
          <span>RTSP <span className="text-gray-200 font-semibold">{cameras.byType.rtsp}</span></span>
          <span>YouTube <span className="text-gray-200 font-semibold">{cameras.byType.youtube}</span></span>
          <span>AI On <span className="text-blue-300 font-semibold">{cameras.aiEnabled}</span></span>
        </div>
        {cameras.total > 0 && (
          <div className="flex gap-1 flex-wrap">
            {Array.from({ length: cameras.byStatus.streaming }).map((_, i) => <span key={`s${i}`} className="w-2 h-2 rounded-full bg-green-500" />)}
            {Array.from({ length: cameras.byStatus.stopped   }).map((_, i) => <span key={`o${i}`} className="w-2 h-2 rounded-full bg-gray-600" />)}
            {Array.from({ length: cameras.byStatus.error     }).map((_, i) => <span key={`e${i}`} className="w-2 h-2 rounded-full bg-red-500" />)}
            {Array.from({ length: cameras.byStatus.connecting}).map((_, i) => <span key={`c${i}`} className="w-2 h-2 rounded-full bg-yellow-500" />)}
          </div>
        )}
      </OverviewCard>

      {/* Zones (static) */}
      <OverviewCard title="Zones" icon="🗺">
        <div className="flex gap-2 flex-wrap">
          <StatChip label="Total"   value={zones.total}          color="text-white" />
          <StatChip label="Monitor" value={zones.byType.MONITOR} color="text-blue-400" />
          <StatChip label="Exclude" value={zones.byType.EXCLUDE} color="text-orange-400" />
        </div>
        {zones.byCamera.length > 0 && (
          <div className="space-y-1">
            {zones.byCamera.slice(0, 5).map(z => (
              <div key={z.cameraId} className="flex items-center gap-1 text-[10px]">
                <span className="text-gray-400 truncate flex-1">{z.cameraName}</span>
                <div className="h-1.5 rounded-full bg-blue-500/60" style={{ width: `${Math.max(8, (z.count / zones.total) * 80)}px` }} />
                <span className="text-gray-300 w-4 text-right">{z.count}</span>
              </div>
            ))}
          </div>
        )}
      </OverviewCard>

      {/* Storage (static, spans full row on xl) */}
      <OverviewCard title="Storage" icon="🗄">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
            storage.mode === 'mongodb'
              ? 'bg-green-900/60 text-green-300 border border-green-700'
              : 'bg-blue-900/60 text-blue-300 border border-blue-700'}`}>
            {storage.mode}
          </span>
          <span className="text-[10px] text-gray-500">Updated {fmtTime(generatedAt)}</span>
        </div>
      </OverviewCard>

      {/* WebRTC connection status */}
      <WebRTCStatsCard refreshTick={refreshTick} />
    </div>
  );
}

// ── Section Drill View (Level 1) ──────────────────────────────────────────────

function SectionDrillView({ section, hourlyState, selectedDate, setSelectedDate, onHourClick, fetchHourly }: {
  section: DrillSection; hourlyState: HourlyFetchState;
  selectedDate: string; setSelectedDate: (d: string) => void;
  onHourClick: (hour: number) => void; fetchHourly: (d: string) => void;
}) {
  const types = SECTION_TYPES[section];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <label className="text-xs text-gray-400">Date</label>
        <input type="date" value={selectedDate} max={todayStr()}
          onChange={e => setSelectedDate(e.target.value)}
          className="bg-gray-800 border border-gray-600 rounded px-3 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500" />
        {hourlyState.status === 'loading' && <span className="text-xs text-gray-500 animate-pulse">Loading…</span>}
        <button onClick={() => fetchHourly(selectedDate)}
          className="ml-auto px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-300 transition-colors">
          ↺ Refresh
        </button>
      </div>

      {hourlyState.status === 'ok' && (() => {
        const { hours, summary } = hourlyState.data;
        const typeSummary = types.reduce((acc, t) => {
          acc[t] = (summary as unknown as Record<string, number>)[t] ?? 0;
          return acc;
        }, {} as Record<string, number>);
        const totalForSection = Object.values(typeSummary).reduce((a, b) => a + b, 0);

        return (
          <>
            <div className="flex gap-3 flex-wrap">
              {types.map(t => (
                <StatChip key={t} label={TYPE_LABELS[t] ?? t} value={typeSummary[t] ?? 0}
                  color={t === 'detections' ? 'text-blue-400' : t === 'alerts' ? 'text-red-400'
                        : t === 'matches' ? 'text-cyan-400' : 'text-amber-400'} />
              ))}
            </div>
            <div className="flex gap-4 text-[10px] text-gray-400 flex-wrap">
              {types.map(t => (
                <span key={t} className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: TYPE_COLORS[t] }} />
                  {TYPE_LABELS[t] ?? t}
                </span>
              ))}
            </div>
            {totalForSection > 0 ? (
              <div>
                <p className="text-xs text-gray-500 mb-2">Click a bar to view items for that hour</p>
                <HourlyStackedChart hours={hours} activeTypes={types} onBarClick={onHourClick} />
              </div>
            ) : (
              <p className="text-sm text-gray-600 text-center py-8">No activity on this date.</p>
            )}
          </>
        );
      })()}
      {hourlyState.status === 'error' && <p className="text-sm text-red-400">Failed to load hourly data.</p>}
    </div>
  );
}

// ── Hour List View (Level 2) ──────────────────────────────────────────────────

function HourListView({ section, hour, selectedDate, itemsState, activeItemType, setActiveItemType, onItemClick }: {
  section: DrillSection; hour: number; selectedDate: string;
  itemsState: ItemsFetchState; activeItemType: string;
  setActiveItemType: (t: string) => void; onItemClick: (item: ItemRecord) => void;
}) {
  const types = SECTION_TYPES[section];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <p className="text-sm text-gray-400">
        Items recorded between <span className="text-white font-semibold">{String(hour).padStart(2,'0')}:00</span>–
        <span className="text-white font-semibold">{String(hour + 1).padStart(2,'0')}:00</span> on {selectedDate}
      </p>

      {itemsState.status === 'loading' && (
        <div className="flex items-center gap-2 text-gray-500 py-8">
          <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="text-sm">Loading items…</span>
        </div>
      )}

      {itemsState.status === 'ok' && (() => {
        const allData = itemsState.data;
        return (
          <>
            {types.length > 1 && (
              <div className="flex gap-2 border-b border-gray-700 pb-2 flex-wrap">
                {types.map(t => {
                  const count = allData[t]?.length ?? 0;
                  const isActive = activeItemType === t;
                  return (
                    <button key={t} onClick={() => setActiveItemType(t)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                        isActive ? 'text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
                      style={isActive ? { background: TYPE_COLORS[t] } : {}}>
                      {TYPE_LABELS[t] ?? t} ({count})
                    </button>
                  );
                })}
              </div>
            )}
            {(() => {
              const items = allData[activeItemType] ?? [];
              if (items.length === 0) return <p className="text-sm text-gray-600 text-center py-8">No items in this hour.</p>;
              return (
                <div className="space-y-1">
                  {items.map((item, idx) => {
                    const primary = primaryField(activeItemType, item);
                    const ts = itemTimestamp(item);
                    const cam = String(item.cameraName || item.cameraId || '');
                    return (
                      <div key={String(item.id ?? idx)} onClick={() => onItemClick(item)}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg bg-gray-800/60
                          hover:bg-gray-700/80 cursor-pointer border border-transparent
                          hover:border-gray-600 transition-all group">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold text-white flex-shrink-0"
                          style={{ background: TYPE_COLORS[activeItemType] ?? '#6b7280' }}>
                          {(TYPE_LABELS[activeItemType] ?? activeItemType).slice(0,3).toUpperCase()}
                        </span>
                        <span className="text-xs text-gray-300 flex-shrink-0 w-[130px]">{ts}</span>
                        {cam && <span className="text-xs text-gray-400 truncate w-[120px]">{cam}</span>}
                        {primary && <span className="text-xs text-gray-200 truncate flex-1">{primary}</span>}
                        <svg className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-300 flex-shrink-0 transition-colors"
                          fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </>
        );
      })()}
      {itemsState.status === 'error' && <p className="text-sm text-red-400">Failed to load items.</p>}
    </div>
  );
}

// ── Item Detail View (Level 3) ────────────────────────────────────────────────

function ItemDetailView({ section, hour, item }: {
  section: DrillSection; hour: number; item: ItemRecord;
}) {
  const typeKey = SECTION_TYPES[section][0] ?? 'detections';
  const ts = itemTimestamp(item);

  const isImageValue = (v: unknown): v is string =>
    typeof v === 'string' && (
      String(v).startsWith('data:image/') ||
      String(v).match(/\.(jpg|jpeg|png|webp|gif)$/i) !== null
    );

  const imageKey = Object.keys(item).find(k =>
    (k.toLowerCase().includes('snapshot') ||
     k.toLowerCase().includes('image') ||
     k.toLowerCase().includes('path') ||
     k.toLowerCase().includes('thumbnail') ||
     k.toLowerCase().includes('photo') ||
     k.toLowerCase().includes('avatar'))
    && isImageValue(item[k])
  );

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="px-3 py-1 rounded-lg text-sm font-bold text-white"
          style={{ background: TYPE_COLORS[typeKey] ?? '#6b7280' }}>
          {TYPE_LABELS[typeKey] ?? typeKey}
        </span>
        {ts && <span className="text-sm text-gray-400">{ts}</span>}
        <span className="text-sm text-gray-600">{String(hour).padStart(2,'0')}:00 · {SECTION_LABELS[section]}</span>
      </div>

      {imageKey && (
        <div className="rounded-lg overflow-hidden bg-gray-800 max-h-64 flex items-center justify-center">
          <img src={String(item[imageKey])} alt="snapshot" className="max-h-64 object-contain"
            onError={e => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }} />
        </div>
      )}

      <div className="bg-gray-900/60 border border-gray-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            {Object.entries(item)
              .filter(([k]) => k !== '__v' && k !== imageKey)
              .map(([k, v]) => {
                let displayVal: React.ReactNode;
                if (typeof v === 'boolean') {
                  displayVal = (
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${v ? 'bg-green-900/60 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
                      {v ? 'Yes' : 'No'}
                    </span>
                  );
                } else if (isImageValue(v)) {
                  displayVal = (
                    <img src={String(v)} alt={k} className="max-h-32 max-w-[180px] rounded object-contain"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  );
                } else if (
                  typeof v === 'string' && v.length > 6 &&
                  (k.toLowerCase().includes('time') || k.toLowerCase().includes('at') || k.toLowerCase().includes('date'))
                ) {
                  displayVal = <span className="text-gray-200">{fmtDateTime(v)}</span>;
                } else if (typeof v === 'number' && v > 1_000_000_000_000) {
                  displayVal = <span className="text-gray-200">{fmtDateTime(v)}</span>;
                } else if (v === null || v === undefined) {
                  displayVal = <span className="text-gray-600">—</span>;
                } else if (typeof v === 'object') {
                  displayVal = <span className="text-gray-300 font-mono text-xs break-all">{JSON.stringify(v)}</span>;
                } else {
                  displayVal = <span className="text-gray-200 break-all">{String(v)}</span>;
                }
                return (
                  <tr key={k} className="border-b border-gray-800 last:border-0">
                    <td className="px-4 py-2.5 text-gray-500 font-medium w-[40%] align-top">{toLabel(k)}</td>
                    <td className="px-4 py-2.5 align-top">{displayVal}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function StatsPanelModal({ open, onClose }: StatsPanelModalProps) {
  const [state, setState]             = useState<FetchState>({ status: 'idle' });
  const [selectedDate, setSelectedDate] = useState<string>(todayStr());
  const [hourlyState, setHourlyState] = useState<HourlyFetchState>({ status: 'idle' });
  const [drill, setDrill]             = useState<DrillState>({ level: 'overview' });
  const [itemsState, setItemsState]   = useState<ItemsFetchState>({ status: 'idle' });
  const [activeItemType, setActiveItemType] = useState<string>('');
  const [refreshTick, setRefreshTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchStats = useCallback(() => {
    setState({ status: 'loading' });
    fetch('/api/stats')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((res: { success: boolean; data: StatsData; error?: string }) => {
        if (res.success && res.data) setState({ status: 'ok', data: res.data });
        else setState({ status: 'error', message: res.error ?? 'Unknown error' });
      })
      .catch((err: Error) => setState({ status: 'error', message: err.message }));
  }, []);

  const fetchHourly = useCallback((date: string) => {
    setHourlyState({ status: 'loading' });
    fetch(`/api/stats/hourly?date=${encodeURIComponent(date)}`)
      .then(r => r.json())
      .then((res: { success: boolean; data: HourlyData }) => {
        if (res.success && res.data) setHourlyState({ status: 'ok', data: res.data });
        else setHourlyState({ status: 'error' });
      })
      .catch(() => setHourlyState({ status: 'error' }));
  }, []);

  const fetchItems = useCallback((types: string[], date: string, hour: number) => {
    setItemsState({ status: 'loading' });
    Promise.all(
      types.map(type =>
        fetch(`/api/stats/items?type=${type}&date=${encodeURIComponent(date)}&hour=${hour}`)
          .then(r => r.json())
          .then((res: { success: boolean; data: { items: ItemRecord[] } }) =>
            res.success ? { type, items: res.data.items } : { type, items: [] as ItemRecord[] }
          )
          .catch(() => ({ type, items: [] as ItemRecord[] }))
      )
    ).then(results => {
      const map: Record<string, ItemRecord[]> = {};
      for (const r of results) map[r.type] = r.items;
      setItemsState({ status: 'ok', data: map });
      if (results.length > 0) setActiveItemType(prev => prev || results[0].type);
    }).catch(() => setItemsState({ status: 'error' }));
  }, []);

  useEffect(() => {
    if (open) { fetchStats(); fetchHourly(selectedDate); }
  }, [open, fetchStats, fetchHourly, selectedDate]);

  useEffect(() => {
    if (!open) { setDrill({ level: 'overview' }); setItemsState({ status: 'idle' }); }
  }, [open]);

  // ESC key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (drill.level === 'overview') onClose();
      else if (drill.level === 'section') setDrill({ level: 'overview' });
      else if (drill.level === 'hourList') setDrill({ level: 'section', section: drill.section });
      else if (drill.level === 'itemDetail') setDrill({ level: 'hourList', section: drill.section, hour: drill.hour });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, drill, onClose]);

  if (!open) return null;

  const handleDrillIn = (section: DrillSection) => {
    setDrill({ level: 'section', section });
    setActiveItemType(SECTION_TYPES[section][0] ?? '');
  };

  const handleHourClick = (hour: number) => {
    if (drill.level !== 'section') return;
    const { section } = drill;
    const types = SECTION_TYPES[section];
    setActiveItemType(types[0] ?? '');
    setDrill({ level: 'hourList', section, hour });
    fetchItems(types, selectedDate, hour);
  };

  const handleItemClick = (item: ItemRecord) => {
    if (drill.level !== 'hourList') return;
    setDrill({ level: 'itemDetail', section: drill.section, hour: drill.hour, item });
  };

  const handleNavigate = (target: 'overview' | 'section') => {
    if (target === 'overview') setDrill({ level: 'overview' });
    else if (target === 'section' && (drill.level === 'hourList' || drill.level === 'itemDetail')) {
      setDrill({ level: 'section', section: drill.section });
    }
  };

  return (
    <div ref={panelRef} className="fixed inset-0 z-50 flex flex-col bg-gray-900"
      aria-modal="true" role="dialog" aria-label="Statistics Panel">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0 bg-gray-900/95 backdrop-blur-sm">
        <div className="flex items-center gap-2.5 min-w-0">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <BreadcrumbNav drill={drill} selectedDate={selectedDate} onNavigate={handleNavigate} />
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => { fetchStats(); fetchHourly(selectedDate); setRefreshTick(t => t + 1); }}
            disabled={state.status === 'loading'}
            className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-40"
            title="Refresh">
            <svg xmlns="http://www.w3.org/2000/svg"
              className={`w-4 h-4 ${state.status === 'loading' ? 'animate-spin' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button onClick={onClose}
            className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            title="Close (Esc)">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {drill.level === 'overview' && (
          <OverviewGrid state={state} hourlyState={hourlyState}
            selectedDate={selectedDate} onDrillIn={handleDrillIn} refreshTick={refreshTick} />
        )}
        {drill.level === 'section' && (
          <SectionDrillView section={drill.section} hourlyState={hourlyState}
            selectedDate={selectedDate} setSelectedDate={setSelectedDate}
            onHourClick={handleHourClick} fetchHourly={fetchHourly} />
        )}
        {drill.level === 'hourList' && (
          <HourListView section={drill.section} hour={drill.hour} selectedDate={selectedDate}
            itemsState={itemsState} activeItemType={activeItemType}
            setActiveItemType={setActiveItemType} onItemClick={handleItemClick} />
        )}
        {drill.level === 'itemDetail' && (
          <ItemDetailView section={drill.section} hour={drill.hour} item={drill.item} />
        )}
      </div>
    </div>
  );
}
