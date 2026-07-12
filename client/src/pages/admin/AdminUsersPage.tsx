import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useOnvifEventStore, type OnvifEventType } from '../../stores/onvifEventStore';
import { useSocket } from '../../hooks/useSocket';
import AdminLogPanel from '../../components/AdminLogPanel';
import { useWebRTCConfigStore, type WebRTCConfig, type TurnServer } from '../../stores/webrtcConfigStore';

// ── Types ────────────────────────────────────────────────────────────────────

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  loginCount: number;
  approvedAt: string | null;
  approvedBy: string | null;
  organization?: string;
  phone?: string;
  bio?: string;
  avatarDataUrl?: string;
}

interface AuditEntry {
  id: string;
  userId: string;
  userEmail?: string;
  event: string;
  detail?: string;
  createdAt: string;
}

interface TcResult {
  id:         string;
  runId:      string;
  runAt:      string;
  suiteFile:  string;
  suiteLabel: string;
  srsRefs:    string;
  suiteMode:  'all' | 'analysis' | 'streaming';
  tcId:       string;
  tcDesc:     string;
  status:     'pass' | 'fail' | 'skip';
  errorMsg:   string | null;
}

interface TcRun {
  runId:   string;
  runAt:   string;
  passed:  number;
  failed:  number;
  skipped: number;
  total:   number;
}

type StatusFilter = 'all' | 'pending' | 'active' | 'rejected' | 'revoked';
type AdminSection = 'users' | 'onvif' | 'audit' | 'ai-models' | 'webrtc' | 'system' | 'logs';

// ── AI Models types ───────────────────────────────────────────────────────────

interface ModelCatalogEntry {
  id:              string;
  label:           string;
  series:          string;
  mAP?:            number;
  cpuMs?:          number;
  t4Ms?:           number;
  params?:         string;
  flops?:          string;
  file:            string;
  exists:          boolean;
  active:          boolean;
  sizeBytes:       number | null;
  downloading:     boolean;
  converting:      boolean;
  downloadPercent: number | null;
  downloadError:   string | null;
  requiresConversion?: boolean;
  // No public pretrained ONNX exists — operator must export manually (e.g. openpar.onnx)
  manualOnly?: boolean;
  docRef?:     string;
  // Non-detector model families. human-parsing / appearance-reid / age-estimation remain
  // Proposed (AI-05 Phase-3 / CrossCamera Phase-2 / Age Estimation) — the rest are
  // production model files.
  family?:  'human-parsing' | 'appearance-reid' | 'face-detection' | 'face-recognition'
          | 'ppe' | 'fire-smoke' | 'cloth-par' | 'age-estimation';
  license?: string;
}

interface AdminModuleItem  { id: string; label: string; desc: string; model?: string; }
interface AdminModuleGroup { groupKey: string; label: string; items: AdminModuleItem[]; }

const ADMIN_MODULE_GROUPS: AdminModuleGroup[] = [
  {
    groupKey: 'core',
    label: 'Core Detection',
    items: [
      { id: 'human',   label: 'Human Detection',   desc: 'Person (COCO yolov8n built-in)' },
      { id: 'vehicle', label: 'Vehicle Detection',  desc: 'Car / truck / bus (COCO yolov8n)' },
    ],
  },
  {
    groupKey: 'attributes',
    label: 'AI Attributes',
    items: [
      { id: 'face',  label: 'Face Recognition', desc: 'SCRFD + ArcFace Re-ID',  model: 'scrfd_2.5g.onnx + arcface_w600k_r50.onnx' },
      { id: 'color', label: 'Color Analysis',   desc: 'Upper/lower body color — no model required' },
      { id: 'cloth', label: 'Cloth Analysis',   desc: 'Clothing type — PromptPAR or OpenPAR, pick one below', model: 'openpar_pa100k.onnx / openpar_resnet50_pa100k.onnx' },
      { id: 'humanParsing', label: 'Human Parsing (Proposed)', desc: 'Precision color via pixel mask — Phase-3', model: 'schp_lip.onnx / segformer_clothes.onnx' },
      { id: 'ageEstimation', label: 'Age Estimation (Proposed)', desc: 'Estimate person age — InsightFace GenderAge or ViT Age Classifier, pick one below', model: 'genderage.onnx / vit_age_classifier.onnx' },
      { id: 'mask',  label: 'Mask Detection',   desc: 'PPE mask compliance',    model: 'yolov8m_ppe.onnx' },
      { id: 'hat',   label: 'Helmet Detection', desc: 'PPE safety helmet',      model: 'yolov8m_ppe.onnx' },
    ],
  },
  {
    groupKey: 'hazards',
    label: 'Hazard Detection',
    items: [
      { id: 'fire',  label: 'Fire Detection',  desc: 'Real-time fire',  model: 'yolov8s_fire_smoke.onnx' },
      { id: 'smoke', label: 'Smoke Detection', desc: 'Early smoke',     model: 'yolov8s_fire_smoke.onnx' },
    ],
  },
];

// Non-detector model families rendered below the YOLO Detection Model table.
// human-parsing / appearance-reid / age-estimation remain Proposed (AI-05 Phase-3 /
// CrossCamera Phase-2 / Age Estimation).
const EXTENDED_SERIES_ORDER = [
  'Face Detection', 'Face Recognition', 'PPE Detection',
  'Fire & Smoke Detection', 'Cloth Attribute (PAR)',
  'Human Parsing', 'Appearance Re-ID', 'Age Estimation',
] as const;
const PROPOSED_SERIES = new Set<string>(['Human Parsing', 'Appearance Re-ID', 'Age Estimation']);

// ── Badges ───────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  active:   'bg-green-900/50 text-green-300 border border-green-700',
  pending:  'bg-yellow-900/50 text-yellow-300 border border-yellow-700',
  rejected: 'bg-red-900/50 text-red-300 border border-red-700',
  revoked:  'bg-gray-700 text-gray-300 border border-gray-600',
};
const ROLE_BADGE: Record<string, string> = {
  admin:    'bg-purple-900/50 text-purple-300',
  operator: 'bg-blue-900/50 text-blue-300',
  viewer:   'bg-gray-700 text-gray-300',
};
const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-900/50 text-red-300',
  warning:  'bg-yellow-900/50 text-yellow-300',
  info:     'bg-blue-900/50 text-blue-300',
};

// ── Nav items ─────────────────────────────────────────────────────────────────

const NAV: { id: AdminSection; label: string; icon: string; desc: string }[] = [
  { id: 'users',     label: 'Users',      icon: '👥', desc: 'Manage user accounts & roles' },
  { id: 'ai-models', label: 'AI Models',  icon: '🤖', desc: 'YOLO model catalog & AI modules' },
  { id: 'webrtc',    label: 'WebRTC / ICE', icon: '📶', desc: 'STUN/TURN servers & ICE connectivity test' },
  { id: 'onvif',     label: 'ONVIF',      icon: '📡', desc: 'Event type registry' },
  { id: 'audit',     label: 'Audit Log',  icon: '📋', desc: 'Activity history' },
  { id: 'system',    label: 'System',     icon: '📊', desc: 'CPU · Memory · Disk · DB metrics' },
  { id: 'logs',      label: 'Server Logs', icon: '🖥️', desc: 'Real-time log viewer' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  const { accessToken, navigateTo } = useAuthStore();
  const [section, setSection] = useState<AdminSection>('users');
  const [serverMode, setServerMode] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') navigateTo('dashboard'); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigateTo]);

  useEffect(() => {
    fetch('/health')
      .then(r => r.json())
      .then((d: { serverMode?: string }) => { if (d.serverMode) setServerMode(d.serverMode.trim().toLowerCase()); })
      .catch(() => {});
  }, []);

  const isStreaming = serverMode === 'streaming';
  const isAnalysis  = serverMode === 'analysis';

  // Visible nav items: hide AI Models in streaming mode (no local models);
  // hide WebRTC/ICE in analysis mode (no camera capture, nothing to configure)
  const visibleNav = NAV.filter(item =>
    !(item.id === 'ai-models' && isStreaming) &&
    !(item.id === 'webrtc'    && isAnalysis)
  );

  async function apiFetch(path: string, opts: RequestInit = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(opts.headers ?? {}),
      },
      ...opts,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  }

  return (
    <div className="h-screen overflow-hidden bg-gray-950 text-white flex flex-col">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="bg-gray-900 border-b border-gray-800 px-5 py-3.5 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigateTo('dashboard')}
            className="text-gray-400 hover:text-white transition-colors"
            title="Back to dashboard"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-gray-600">|</span>
          <h1 className="text-base font-semibold tracking-tight">Admin Dashboard</h1>
          <span className="text-[10px] bg-purple-900/60 text-purple-300 border border-purple-700/50
                          px-2 py-0.5 rounded-full font-medium">Admin</span>
        </div>
        <button
          onClick={() => navigateTo('dashboard')}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Dashboard →
        </button>
      </header>

      {/* ── Body: sidebar + content ────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Sidebar */}
        <nav className="w-52 flex-shrink-0 bg-gray-900 border-r border-gray-800
                        flex flex-col py-4 gap-1 overflow-y-auto">
          {visibleNav.map(item => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-left
                          transition-colors text-sm ${
                section === item.id
                  ? 'bg-blue-600/20 text-white border border-blue-600/30'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              <span className="text-base w-5 text-center">{item.icon}</span>
              <div>
                <div className="font-medium leading-tight">{item.label}</div>
                <div className="text-[10px] text-gray-500 leading-tight mt-0.5">{item.desc}</div>
              </div>
            </button>
          ))}
        </nav>

        {/* Content — logs section uses inner scroll; all other sections scroll the main area */}
        <main className={`flex-1 bg-gray-950 ${section === 'logs' ? 'overflow-hidden flex flex-col' : 'overflow-y-auto'}`}>
          {section === 'users'     && <UsersSection apiFetch={apiFetch} />}
          {section === 'ai-models' && <AiModelsSection />}
          {section === 'webrtc'    && <WebRTCSection />}
          {section === 'onvif'     && <OnvifSection apiFetch={apiFetch} />}
          {section === 'audit'     && <AuditSection apiFetch={apiFetch} />}
          {section === 'system'    && <SystemSection apiFetch={apiFetch} />}
          {section === 'logs'      && (
            <AdminLogPanel apiFetch={apiFetch} serverMode={serverMode} />
          )}
        </main>
      </div>
    </div>
  );
}

// ── Section: Users ─────────────────────────────────────────────────────────

function UsersSection({ apiFetch }: { apiFetch: (p: string, o?: RequestInit) => Promise<unknown> }) {
  const [users, setUsers]       = useState<User[]>([]);
  const [filter, setFilter]     = useState<StatusFilter>('all');
  const [search, setSearch]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [actionId, setActionId] = useState<string | null>(null);

  async function loadUsers() {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (search)           params.set('search', search);
      const data = await apiFetch(`/admin/users?${params}`) as { users?: User[] };
      setUsers(data.users ?? []);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadUsers(); }, [filter, search]);

  async function handleAction(userId: string, action: string, role?: string) {
    setActionId(userId);
    try {
      await apiFetch(`/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ action, role }) });
      await loadUsers();
    } catch (e: unknown) { alert((e as Error).message); }
    finally { setActionId(null); }
  }

  async function handleDelete(userId: string, email: string) {
    if (!confirm(`Delete user ${email}? This cannot be undone.`)) return;
    setActionId(userId);
    try {
      await apiFetch(`/admin/users/${userId}`, { method: 'DELETE' });
      await loadUsers();
    } catch (e: unknown) { alert((e as Error).message); }
    finally { setActionId(null); }
  }

  const fmt = (s: string | null) => s ? new Date(s).toLocaleDateString() : '—';

  return (
    <div className="p-6">
      <SectionHeader title="User Management" subtitle="Approve, reject, and manage user roles" />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="flex bg-gray-800 rounded-lg p-1 gap-1">
          {(['all', 'pending', 'active', 'rejected', 'revoked'] as StatusFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                filter === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by email, name, org…"
          className="flex-1 min-w-[200px] bg-gray-800 border border-gray-700 rounded-lg
                     px-4 py-2 text-sm text-white placeholder-gray-500
                     focus:outline-none focus:border-blue-500"
        />
      </div>

      {error && <ErrorBar msg={error} />}

      {loading ? (
        <EmptyState msg="Loading…" />
      ) : users.length === 0 ? (
        <EmptyState msg="No users found." />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wide">
                <th className="text-left px-5 py-3">User</th>
                <th className="text-left px-4 py-3">Organization</th>
                <th className="text-left px-4 py-3">Role</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Joined</th>
                <th className="text-left px-4 py-3">Last Login</th>
                <th className="text-left px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      {u.avatarDataUrl
                        ? <img src={u.avatarDataUrl} alt="avatar" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                        : <span className="w-7 h-7 rounded-full bg-blue-700 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                            {(u.name || u.email).charAt(0).toUpperCase()}
                          </span>
                      }
                      <div>
                        <div className="font-medium text-white leading-tight">{u.name || u.email}</div>
                        <div className="text-gray-500 text-xs">{u.email}</div>
                        {u.phone && <div className="text-gray-500 text-xs">{u.phone}</div>}
                      </div>
                    </div>
                    {u.bio && <p className="text-gray-500 text-xs mt-1 ml-9 max-w-xs truncate">{u.bio}</p>}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm">{u.organization || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full capitalize font-medium ${ROLE_BADGE[u.role] ?? ''}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full capitalize font-medium ${STATUS_BADGE[u.status] ?? ''}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400">{fmt(u.createdAt)}</td>
                  <td className="px-4 py-3 text-gray-400">{fmt(u.lastLoginAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {u.status === 'pending' && (
                        <>
                          <button onClick={() => handleAction(u.id, 'approve')} disabled={actionId === u.id}
                            className="px-2.5 py-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded text-xs font-medium">
                            Approve
                          </button>
                          <button onClick={() => handleAction(u.id, 'reject')} disabled={actionId === u.id}
                            className="px-2.5 py-1 bg-red-800 hover:bg-red-700 disabled:opacity-50 text-white rounded text-xs font-medium">
                            Reject
                          </button>
                        </>
                      )}
                      {u.status === 'active' && (
                        <>
                          <select
                            defaultValue={u.role}
                            onChange={e => handleAction(u.id, 'approve', e.target.value)}
                            disabled={actionId === u.id}
                            className="text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1 disabled:opacity-50"
                          >
                            <option value="admin">admin</option>
                            <option value="operator">operator</option>
                            <option value="viewer">viewer</option>
                          </select>
                          <button onClick={() => handleAction(u.id, 'revoke')} disabled={actionId === u.id}
                            className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded text-xs font-medium">
                            Revoke
                          </button>
                        </>
                      )}
                      {(u.status === 'rejected' || u.status === 'revoked') && (
                        <button onClick={() => handleAction(u.id, 'reactivate')} disabled={actionId === u.id}
                          className="px-2.5 py-1 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white rounded text-xs font-medium">
                          Reactivate
                        </button>
                      )}
                      <button onClick={() => handleDelete(u.id, u.email)} disabled={actionId === u.id}
                        className="px-2.5 py-1 bg-transparent hover:bg-red-900/30 disabled:opacity-50 text-red-400 hover:text-red-300 rounded text-xs font-medium transition-colors"
                        title="Delete user">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Section: ONVIF ─────────────────────────────────────────────────────────

function OnvifSection({ apiFetch }: { apiFetch: (p: string, o?: RequestInit) => Promise<unknown> }) {
  const { types, setTypes, addType, clearTypes } = useOnvifEventStore();
  const { socket } = useSocket();
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const data = await apiFetch('/api/onvif-event-types') as { types?: OnvifEventType[] };
      if (Array.isArray(data.types)) setTypes(data.types);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function handleClear() {
    if (!confirm('Clear the ONVIF event type registry?\n\nNew types will be re-registered automatically as ONVIF events arrive.')) return;
    try {
      await apiFetch('/api/onvif-event-types', { method: 'DELETE' });
      clearTypes();
    } catch (e: unknown) { alert((e as Error).message); }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!socket) return;
    const handler = (type: OnvifEventType) => { addType(type); };
    socket.on('onvif:type-registered', handler);
    return () => { socket.off('onvif:type-registered', handler); };
  }, [socket, addType]);

  return (
    <div className="p-6">
      <SectionHeader
        title="ONVIF Event Type Registry"
        subtitle="Global registry of all ONVIF event types ever detected. Populates the Event Type filter in the timeline view."
      />

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="Registered Types" value={types.length} color="blue" />
        <StatCard label="Critical" value={types.filter(t => t.severity === 'critical').length} color="red" />
        <StatCard label="Warning"  value={types.filter(t => t.severity === 'warning').length}  color="yellow" />
      </div>

      {/* Table card */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-800 flex items-center justify-between">
          <p className="text-xs text-gray-500">
            Types are registered automatically when new ONVIF events are received for the first time.
          </p>
          <div className="flex items-center gap-2 flex-shrink-0 ml-4">
            <button onClick={load} disabled={loading}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50
                         text-gray-300 rounded-lg text-xs font-medium transition-colors">
              {loading ? 'Loading…' : '↺ Refresh'}
            </button>
            <button onClick={handleClear} disabled={loading || types.length === 0}
              className="px-3 py-1.5 bg-transparent hover:bg-red-900/30 disabled:opacity-40
                         text-red-400 hover:text-red-300 rounded-lg text-xs font-medium
                         transition-colors border border-red-900/40">
              Clear Registry
            </button>
          </div>
        </div>

        {error && <ErrorBar msg={error} />}

        {types.length === 0 ? (
          <EmptyState msg={loading ? 'Loading…' : 'No event types registered yet. Types are added automatically as ONVIF events arrive.'} />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-left">
                <th className="px-5 py-3 font-medium">Type Key</th>
                <th className="px-4 py-3 font-medium">Label</th>
                <th className="px-4 py-3 font-medium">Severity</th>
                <th className="px-4 py-3 font-medium">Topic URI</th>
                <th className="px-4 py-3 font-medium">First Seen</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t: OnvifEventType) => (
                <tr key={t.topicType} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-3 font-mono text-blue-400">{t.topicType}</td>
                  <td className="px-4 py-3 text-white font-medium">{t.topicLabel}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${SEVERITY_BADGE[t.severity] ?? ''}`}>
                      {t.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-500 text-[10px] max-w-[260px] truncate" title={t.topic}>
                    {t.topic}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {new Date(t.firstSeenAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Section: Audit Log ────────────────────────────────────────────────────

type AuditTab = 'tests' | 'activity';

function AuditSection({
  apiFetch,
}: {
  apiFetch: (p: string, o?: RequestInit) => Promise<unknown>;
}) {
  const [tab, setTab] = useState<AuditTab>('tests');

  return (
    <div className="p-6">
      <SectionHeader title="Audit Log" subtitle="Startup test results and system activity" />

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 bg-gray-800 rounded-lg p-1 w-fit">
        {([
          { id: 'tests',    label: '🧪 Startup Tests' },
          { id: 'activity', label: '📋 System Activity' },
        ] as { id: AuditTab; label: string }[]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
              tab === t.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'tests'    && <TcResultsPanel apiFetch={apiFetch} />}
      {tab === 'activity' && <ActivityLogPanel apiFetch={apiFetch} />}
    </div>
  );
}

// ── TC Results Panel ──────────────────────────────────────────────────────────

type TcFilter = 'all' | 'pass' | 'fail' | 'skip';

function TcResultsPanel({
  apiFetch,
}: {
  apiFetch: (p: string, o?: RequestInit) => Promise<unknown>;
}) {
  const [run,     setRun]     = useState<TcRun | null>(null);
  const [results, setResults] = useState<TcResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error,   setError]   = useState('');
  const [filter,  setFilter]  = useState<TcFilter>('all');
  const [search,  setSearch]  = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    setLoading(true); setError('');
    try {
      const data = await apiFetch('/admin/tc-results') as {
        run: TcRun | null; results: TcResult[]; running: boolean;
      };
      setRun(data.run ?? null);
      setResults(data.results ?? []);
      setRunning(data.running ?? false);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function handleReRun() {
    try {
      await apiFetch('/admin/tc-results/run', { method: 'POST' });
      setRunning(true);
    } catch (e: unknown) { alert((e as Error).message); }
  }

  async function handleClear() {
    if (!confirm('Delete all stored TC results?')) return;
    try {
      await apiFetch('/admin/tc-results', { method: 'DELETE' });
      setRun(null); setResults([]);
    } catch (e: unknown) { alert((e as Error).message); }
  }

  // Poll while a run is in progress
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (running) {
      if (pollRef.current) return;
      pollRef.current = setInterval(async () => {
        try {
          const data = await apiFetch('/admin/tc-results') as {
            run: TcRun | null; results: TcResult[]; running: boolean;
          };
          setRun(data.run ?? null);
          setResults(data.results ?? []);
          if (!data.running) {
            setRunning(false);
            clearInterval(pollRef.current!);
            pollRef.current = null;
          }
        } catch { /* ignore poll errors */ }
      }, 3000);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current!); pollRef.current = null; } };
  }, [running]);

  const filtered = results.filter(r => {
    if (filter !== 'all' && r.status !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return r.tcId.toLowerCase().includes(q)
        || r.tcDesc.toLowerCase().includes(q)
        || r.srsRefs.toLowerCase().includes(q)
        || r.suiteLabel.toLowerCase().includes(q);
    }
    return true;
  });

  // Group by suite — all results shown (skipped suites included per server mode)
  const suiteGroups = filtered.reduce<Record<string, TcResult[]>>((acc, r) => {
    if (!acc[r.suiteFile]) acc[r.suiteFile] = [];
    acc[r.suiteFile].push(r);
    return acc;
  }, {});

  return (
    <div>
      {/* Summary row */}
      {run && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="grid grid-cols-4 gap-3 flex-1 min-w-0">
            <StatCard label="Passed"  value={run.passed}  color="green" />
            <StatCard label="Failed"  value={run.failed}  color="red" />
            <StatCard label="Skipped" value={run.skipped} color="yellow" />
            <StatCard label="Total"   value={run.total}   color="blue" />
          </div>
        </div>
      )}

      {run && (
        <div className="mb-4 text-[11px] text-gray-500">
          Last run: <span className="text-gray-400">{new Date(run.runAt).toLocaleString()}</span>
          {running && <span className="ml-2 text-blue-400 animate-pulse">● Running…</span>}
        </div>
      )}

      {!run && !loading && !running && (
        <div className="mb-4 text-sm text-gray-500">
          No test results yet. Tests run automatically after server startup.
        </div>
      )}

      {running && !run && (
        <div className="mb-4 text-sm text-blue-400 animate-pulse">● Test run in progress…</div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Status filter */}
        <div className="flex bg-gray-800 rounded-lg p-1 gap-1">
          {(['all', 'pass', 'fail', 'skip'] as TcFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                filter === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter TC ID, description, SRS…"
          className="flex-1 min-w-[180px] bg-gray-800 border border-gray-700 rounded-lg
                     px-3 py-2 text-xs text-white placeholder-gray-500
                     focus:outline-none focus:border-blue-500"
        />

        <button onClick={load} disabled={loading}
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50
                     text-gray-300 rounded-lg text-xs font-medium transition-colors">
          {loading ? '…' : '↺'}
        </button>

        <button
          onClick={handleReRun}
          disabled={running}
          className="px-3 py-2 bg-blue-700/70 hover:bg-blue-700 disabled:opacity-40
                     text-blue-200 rounded-lg text-xs font-medium transition-colors border border-blue-600/40"
        >
          {running ? 'Running…' : '▶ Re-run Tests'}
        </button>

        <button
          onClick={handleClear}
          disabled={!run || running}
          className="px-3 py-2 bg-transparent hover:bg-red-900/30 disabled:opacity-40
                     text-red-400 hover:text-red-300 rounded-lg text-xs font-medium
                     transition-colors border border-red-900/40"
        >
          Clear
        </button>
      </div>

      {error && <ErrorBar msg={error} />}

      {loading ? (
        <EmptyState msg="Loading…" />
      ) : Object.keys(suiteGroups).length === 0 ? (
        <EmptyState msg={results.length === 0
          ? (running ? 'Test run in progress — results will appear here…' : 'No test results available.')
          : `No results match the current filter.`}
        />
      ) : (
        <div className="space-y-3">
          {Object.entries(suiteGroups).map(([suiteFile, rows]) => {
            const srsRefs    = rows[0].srsRefs;
            const suiteLabel = rows[0].suiteLabel;
            const suiteMode  = rows[0].suiteMode ?? 'all';
            const suitePass  = rows.filter(r => r.status === 'pass').length;
            const suiteFail  = rows.filter(r => r.status === 'fail').length;
            const suiteSkip  = rows.filter(r => r.status === 'skip').length;
            const allSkipped = rows.length > 0 && rows.every(r => r.status === 'skip');
            const dotColor   = suiteFail > 0 ? 'bg-red-500' : allSkipped ? 'bg-yellow-500' : 'bg-green-500';
            return (
              <div key={suiteFile} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                {/* Suite header */}
                <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between gap-3 bg-gray-900/80">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
                    <span className="text-xs font-semibold text-gray-200 truncate">{suiteLabel}</span>
                    {suiteMode === 'analysis' && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold flex-shrink-0
                                       bg-purple-900/40 text-purple-400 border border-purple-800/40">
                        Analysis
                      </span>
                    )}
                    {suiteMode === 'streaming' && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold flex-shrink-0
                                       bg-cyan-900/40 text-cyan-400 border border-cyan-800/40">
                        Streaming
                      </span>
                    )}
                    <span className="text-[10px] text-gray-500 font-mono truncate hidden sm:block">{srsRefs}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 text-[10px]">
                    {suitePass > 0 && <span className="text-green-400 font-medium">✓ {suitePass}</span>}
                    {suiteFail > 0 && <span className="text-red-400 font-medium">✗ {suiteFail}</span>}
                    {suiteSkip > 0 && <span className="text-yellow-500 font-medium">⊘ {suiteSkip}</span>}
                  </div>
                </div>

                {/* TC rows */}
                <table className="w-full text-xs">
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id} className="border-b border-gray-800/40 last:border-0 hover:bg-gray-800/20 transition-colors">
                        <td className="px-4 py-2 w-28 flex-shrink-0">
                          <span className="font-mono text-blue-400 text-[11px]">{r.tcId}</span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="text-gray-300 leading-snug">{r.tcDesc}</div>
                          {r.errorMsg && (
                            <div className="text-red-400/80 text-[10px] mt-0.5 font-mono truncate max-w-xs" title={r.errorMsg}>
                              {r.errorMsg}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right w-20">
                          <StatusBadge status={r.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: 'pass' | 'fail' | 'skip' }) {
  const map = {
    pass: 'bg-green-900/50 text-green-300 border border-green-700/50',
    fail: 'bg-red-900/50 text-red-300 border border-red-700/50',
    skip: 'bg-gray-700 text-gray-400 border border-gray-600',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase ${map[status]}`}>
      {status}
    </span>
  );
}

// ── Activity Log Panel ────────────────────────────────────────────────────────

function ActivityLogPanel({ apiFetch }: { apiFetch: (p: string, o?: RequestInit) => Promise<unknown> }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [search,  setSearch]  = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const data = await apiFetch('/admin/audit?limit=200') as { events?: AuditEntry[] };
      setEntries(data.events ?? []);
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const filtered = entries.filter(e =>
    !search ||
    e.event.toLowerCase().includes(search.toLowerCase()) ||
    (e.userEmail ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (e.detail ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by event, user, or detail…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2
                     text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button onClick={load} disabled={loading}
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50
                     text-gray-300 rounded-lg text-xs font-medium transition-colors flex-shrink-0">
          {loading ? '…' : '↺ Refresh'}
        </button>
      </div>

      {error && <ErrorBar msg={error} />}

      {loading ? (
        <EmptyState msg="Loading…" />
      ) : filtered.length === 0 ? (
        <EmptyState msg={search ? `No entries matching "${search}".` : 'No audit entries yet. Login/logout and user management events appear here.'} />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-left">
                <th className="px-5 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Event</th>
                <th className="px-4 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => (
                <tr key={e.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                  <td className="px-5 py-2.5 text-gray-500 whitespace-nowrap">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-gray-300">{e.userEmail ?? e.userId ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-blue-400">{e.event}</span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 max-w-xs truncate" title={e.detail ?? ''}>
                    {e.detail ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: 'blue' | 'red' | 'yellow' | 'green' }) {
  const colors = {
    blue:   'bg-blue-900/20 border-blue-800/40 text-blue-400',
    red:    'bg-red-900/20  border-red-800/40  text-red-400',
    yellow: 'bg-yellow-900/20 border-yellow-800/40 text-yellow-400',
    green:  'bg-green-900/20 border-green-800/40 text-green-400',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function ErrorBar({ msg }: { msg: string }) {
  return (
    <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-300 text-xs">
      {msg}
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return (
    <div className="text-center py-16 text-gray-600 text-sm">{msg}</div>
  );
}

// ── Section: AI Models ────────────────────────────────────────────────────────

function AiModelsSection() {
  const [catalog,    setCatalog]    = useState<ModelCatalogEntry[]>([]);
  const [switching,  setSwitching]  = useState<string | null>(null);
  const [dlLoading,  setDlLoading]  = useState<string | null>(null);
  const [dlError,    setDlError]    = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [enabled,    setEnabled]    = useState<Record<string, boolean>>({});
  const [caps,       setCaps]       = useState<Record<string, boolean>>({});
  const [capStatus,  setCapStatus]  = useState<Record<string, string>>({});
  const [modSaving,  setModSaving]  = useState<string | null>(null);

  const [loadError, setLoadError] = useState(false);

  const fetchCatalog = useCallback(async () => {
    try {
      const r = await fetch('/api/analysis/models');
      if (!r.ok) return;
      const data = await r.json();
      const list: ModelCatalogEntry[] = data.catalog ?? [];
      setCatalog(list);
      // stop polling once nothing is in-flight
      const anyActive = list.some(m => m.downloading || m.converting);
      if (!anyActive && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchCatalog();
    Promise.all([
      fetch('/api/analytics/config').then(r => r.json()),
      fetch('/api/capabilities').then(r => r.json()),
    ])
      .then(([cfg, cap]) => {
        if (cfg.success) setEnabled(cfg.data);
        if (cap.ai)      setCaps(cap.ai);
        if (cap.status)  setCapStatus(cap.status);
      })
      .catch(() => setLoadError(true));
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchCatalog]);

  const startPolling = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(fetchCatalog, 2000);
  };

  const switchModel = async (id: string) => {
    setSwitching(id);
    try {
      const r = await fetch('/api/analysis/models/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: id }),
      });
      if (r.ok) await fetchCatalog();
      else {
        const b = await r.json().catch(() => ({}));
        setDlError(b.error ?? 'Switch failed');
      }
    } finally { setSwitching(null); }
  };

  const deactivateModel = async (id: string) => {
    setSwitching(id);
    try {
      const r = await fetch('/api/analysis/models/deactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: id }),
      });
      if (r.ok) await fetchCatalog();
      else {
        const b = await r.json().catch(() => ({}));
        setDlError(b.error ?? 'Deactivate failed');
      }
    } finally { setSwitching(null); }
  };

  const downloadModel = async (id: string) => {
    setDlLoading(id); setDlError(null);
    try {
      const r = await fetch('/api/analysis/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: id }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setDlError(b.error ?? 'Download failed'); return; }
      if (!b.already) startPolling();
      await fetchCatalog();
    } finally { setDlLoading(null); }
  };

  const toggleModule = async (id: string) => {
    const next = !enabled[id];
    setEnabled(prev => ({ ...prev, [id]: next }));
    setModSaving(id);
    try {
      await fetch('/api/analytics/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [id]: next }),
      });
    } catch {
      setEnabled(prev => ({ ...prev, [id]: !next }));
    } finally { setModSaving(null); }
  };

  const SERIES_ORDER = ['YOLO26', 'YOLO12', 'YOLO11', 'YOLOv8'];

  return (
    <div className="p-6 space-y-8">
      <SectionHeader
        title="AI Models"
        subtitle="Full AI model catalog — download, activate, and configure every detection/attribute/hazard model"
      />

      {loadError && <ErrorBar msg="Failed to load AI configuration. Is the analysis server running?" />}
      {dlError   && <ErrorBar msg={dlError} />}

      {/* ── YOLO Detection Model Catalog ── */}
      <div>
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <span className="text-indigo-400">◈</span>
          YOLO Detection Model
          {catalog.find(m => m.active) && (
            <span className="text-[10px] bg-indigo-800/60 text-indigo-200 border border-indigo-600/40 rounded px-2 py-0.5">
              Active: {catalog.find(m => m.active)!.label}
            </span>
          )}
        </h3>

        <div className="space-y-4">
          {SERIES_ORDER.map(series => {
            const entries = catalog.filter(m => m.series === series);
            if (!entries.length) return null;
            return (
              <div key={series} className="border border-gray-800 rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-gray-900 border-b border-gray-800 flex items-center gap-2">
                  <span className="text-xs font-bold text-gray-300">{series}</span>
                  {(series === 'YOLO26' || series === 'YOLO12') && (
                    <span className="text-[9px] bg-amber-900/50 text-amber-300 border border-amber-700/40 rounded px-1.5 py-0.5">
                      PT→ONNX auto-convert
                    </span>
                  )}
                </div>

                {/* Table header */}
                <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto] gap-x-4 px-4 py-1.5 bg-gray-900/60 border-b border-gray-800 text-[10px] text-gray-500 uppercase tracking-wide">
                  <span>Model</span>
                  <span className="text-right">mAP</span>
                  <span className="text-right">CPU ms</span>
                  <span className="text-right">T4 ms</span>
                  <span className="text-right">Params</span>
                  <span className="text-right">Size</span>
                  <span className="text-right">Action</span>
                </div>

                {entries.map(m => {
                  const isSwitching  = switching === m.id;
                  const isDownloading = dlLoading === m.id || m.downloading;
                  const pct = m.downloadPercent ?? 0;
                  return (
                    <div
                      key={m.id}
                      className={`grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto] gap-x-4 items-center px-4 py-2.5 border-b border-gray-800/60 last:border-0 transition-colors ${
                        m.active ? 'bg-indigo-950/30' : 'hover:bg-gray-900/40'
                      }`}
                    >
                      {/* Model label + status */}
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                          m.active ? 'border-indigo-400 bg-indigo-400' : 'border-gray-600'
                        }`} />
                        <span className={`text-sm font-mono font-semibold ${m.active ? 'text-indigo-300' : 'text-gray-200'}`}>
                          {m.label}
                        </span>
                        {m.active && (
                          <span className="text-[9px] text-indigo-400 font-medium">● active</span>
                        )}
                        {m.converting && (
                          <span className="text-[9px] text-amber-400 animate-pulse">⟳ converting…</span>
                        )}
                        {m.downloading && !m.converting && (
                          <span className="text-[9px] text-blue-400 animate-pulse">↓ {pct}%</span>
                        )}
                        {m.downloadError && (
                          <span className="text-[9px] text-red-400" title={m.downloadError}>✗ error</span>
                        )}
                      </div>

                      {/* mAP */}
                      <span className={`text-xs font-mono text-right tabular-nums ${
                        (m.mAP ?? 0) >= 51 ? 'text-green-400' : (m.mAP ?? 0) >= 44 ? 'text-yellow-400' : 'text-gray-400'
                      }`}>{m.mAP}</span>

                      {/* CPU ms */}
                      <span className={`text-xs font-mono text-right tabular-nums ${
                        (m.cpuMs ?? 0) <= 90 ? 'text-green-400' : (m.cpuMs ?? 0) <= 240 ? 'text-yellow-400' : 'text-red-400'
                      }`}>{m.cpuMs}</span>

                      {/* T4 ms */}
                      <span className="text-xs font-mono text-right tabular-nums text-gray-500">{m.t4Ms}</span>

                      {/* Params */}
                      <span className="text-xs font-mono text-right text-gray-500">{m.params}</span>

                      {/* File size */}
                      <span className="text-xs font-mono text-right text-gray-600">
                        {m.sizeBytes ? `${(m.sizeBytes / 1024 / 1024).toFixed(0)}MB` : '—'}
                      </span>

                      {/* Action */}
                      <div className="flex justify-end">
                        {!m.exists && !isDownloading && (
                          <button
                            onClick={() => downloadModel(m.id)}
                            disabled={!!dlLoading}
                            className="px-2.5 py-1 text-[10px] font-medium rounded bg-blue-700/70 text-blue-200 border border-blue-600/50 hover:bg-blue-700 disabled:opacity-40 transition-colors"
                          >
                            {series === 'YOLO12' ? '↓ PT→ONNX' : '↓ Download'}
                          </button>
                        )}
                        {isDownloading && (
                          <span className="text-[10px] text-blue-400 animate-pulse">
                            {m.converting ? 'Converting…' : `${pct}%`}
                          </span>
                        )}
                        {m.exists && !m.active && !isSwitching && (
                          <button
                            onClick={() => switchModel(m.id)}
                            disabled={!!switching}
                            className="px-2.5 py-1 text-[10px] font-medium rounded bg-indigo-700/70 text-indigo-200 border border-indigo-600/50 hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                          >
                            Activate
                          </button>
                        )}
                        {isSwitching && (
                          <span className="text-[10px] text-yellow-400 animate-pulse">Switching…</span>
                        )}
                        {m.active && (
                          <span className="text-[10px] text-indigo-400 font-medium">Active</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="mt-2 flex flex-wrap gap-4 text-[10px] text-gray-600">
          <span><span className="text-green-400">■</span> Fast / High accuracy</span>
          <span><span className="text-yellow-400">■</span> Moderate</span>
          <span><span className="text-red-400">■</span> Slow / Heavy</span>
          <span className="ml-auto">mAP COCO val2017 50-95 · ONNX Runtime CPU ms</span>
        </div>
      </div>

      {/* ── Additional Model Families (Face / PPE / Fire-Smoke / Cloth-PAR / Human Parsing / Appearance Re-ID) ── */}
      {EXTENDED_SERIES_ORDER.map(series => {
        const entries = catalog.filter(m => m.series === series);
        if (!entries.length) return null;
        const isProposed = PROPOSED_SERIES.has(series);
        return (
          <div key={series}>
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <span className={isProposed ? 'text-purple-400' : 'text-cyan-400'}>◈</span>
              {series}
              {isProposed && (
                <span className="text-[9px] bg-purple-900/50 text-purple-300 border border-purple-700/40 rounded px-1.5 py-0.5">
                  Proposed
                </span>
              )}
              {entries.find(m => m.active) && (
                <span className="text-[10px] bg-indigo-800/60 text-indigo-200 border border-indigo-600/40 rounded px-2 py-0.5">
                  Active: {entries.find(m => m.active)!.label}
                </span>
              )}
            </h3>
            <div className="border border-gray-800 rounded-lg overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-1.5 bg-gray-900/60 border-b border-gray-800 text-[10px] text-gray-500 uppercase tracking-wide">
                <span>Model</span>
                <span>License</span>
                <span className="text-right">Size</span>
                <span className="text-right">Action</span>
              </div>
              {entries.map(m => {
                const isSwitching   = switching === m.id;
                const isDownloading = dlLoading === m.id || m.downloading;
                const pct = m.downloadPercent ?? 0;
                return (
                  <div
                    key={m.id}
                    className={`grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center px-4 py-2.5 border-b border-gray-800/60 last:border-0 transition-colors ${
                      m.active ? 'bg-indigo-950/30' : 'hover:bg-gray-900/40'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                        m.active ? 'border-indigo-400 bg-indigo-400' : 'border-gray-600'
                      }`} />
                      <span className={`text-sm font-mono font-semibold ${m.active ? 'text-indigo-300' : 'text-gray-200'}`}>
                        {m.label}
                      </span>
                      {m.active && <span className="text-[9px] text-indigo-400 font-medium">● active</span>}
                      {m.downloading && (
                        <span className="text-[9px] text-blue-400 animate-pulse">↓ {pct}%</span>
                      )}
                      {m.downloadError && (
                        <span className="text-[9px] text-red-400" title={m.downloadError}>✗ error</span>
                      )}
                    </div>
                    <span className="text-[10px] text-gray-500 truncate" title={m.license}>{m.license ?? '—'}</span>
                    <span className="text-xs font-mono text-right text-gray-600">
                      {m.sizeBytes ? `${(m.sizeBytes / 1024 / 1024).toFixed(0)}MB` : '—'}
                    </span>
                    <div className="flex justify-end">
                      {m.manualOnly && !m.exists && (
                        <a
                          href={m.docRef}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="No public pretrained ONNX — export manually, then place the file in server/models/"
                          className="text-[10px] text-gray-500 underline decoration-dotted hover:text-gray-300"
                        >
                          Manual export
                        </a>
                      )}
                      {!m.exists && !m.manualOnly && !isDownloading && (
                        <button
                          onClick={() => downloadModel(m.id)}
                          disabled={!!dlLoading}
                          className="px-2.5 py-1 text-[10px] font-medium rounded bg-blue-700/70 text-blue-200 border border-blue-600/50 hover:bg-blue-700 disabled:opacity-40 transition-colors"
                        >
                          ↓ Download
                        </button>
                      )}
                      {isDownloading && (
                        <span className="text-[10px] text-blue-400 animate-pulse">
                          {m.converting ? 'Converting…' : `${pct}%`}
                        </span>
                      )}
                      {m.exists && !m.active && !isSwitching && (
                        <button
                          onClick={() => switchModel(m.id)}
                          disabled={!!switching}
                          className="px-2.5 py-1 text-[10px] font-medium rounded bg-indigo-700/70 text-indigo-200 border border-indigo-600/50 hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                        >
                          Activate
                        </button>
                      )}
                      {isSwitching && <span className="text-[10px] text-yellow-400 animate-pulse">Switching…</span>}
                      {m.active && !isSwitching && (
                        <button
                          onClick={() => deactivateModel(m.id)}
                          disabled={!!switching}
                          title="Unload this model from memory — no model will be active for this family until you Activate one again"
                          className="px-2.5 py-1 text-[10px] font-medium rounded bg-gray-700/70 text-gray-300 border border-gray-600/50 hover:bg-red-900/60 hover:text-red-200 hover:border-red-700/50 disabled:opacity-40 transition-colors"
                        >
                          Deactivate
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] text-gray-600">
              {isProposed
                ? 'Not yet enabled by default — verify the model source before downloading. See docs/design/Design_AI_Color_Analysis.md §10 / Design_AI_AppearanceReID.md §12.'
                : series === 'Cloth Attribute (PAR)'
                ? 'PromptPAR (CLIP ViT-L) requires ≥ 2GB free system RAM to activate — if unavailable, activation fails, Cloth Analysis is turned off, and the reason is logged server-side. OpenPAR (ResNet50) is a lighter alternative with no memory gate. See docs/design/Design_AI_Cloth_Analysis.md §Memory Gate.'
                : 'Required by the corresponding AI Analysis Module below — see docs/design/Design_AI_Model_Catalog.md.'}
              {' '}Deactivate unloads the model from memory without downloading — Activate again anytime.
            </p>
          </div>
        );
      })}

      {/* ── AI Module Enable / Disable ── */}
      <div>
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <span className="text-green-400">◈</span>
          AI Analysis Modules
        </h3>

        <div className="space-y-4">
          {ADMIN_MODULE_GROUPS.map(group => (
            <div key={group.groupKey} className="border border-gray-800 rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-gray-900 border-b border-gray-800">
                <span className="text-xs font-bold text-gray-300">{group.label}</span>
              </div>
              <div className="divide-y divide-gray-800/60">
                {group.items.map(item => {
                  const available = caps[item.id] !== false;
                  const st        = capStatus[item.id] ?? '';
                  const isOn      = enabled[item.id] === true;
                  const isSaving  = modSaving === item.id;
                  const isFailed  = st === 'failed' || st === 'missing';

                  return (
                    <div key={item.id} className="flex items-center justify-between px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${available && !isFailed ? 'text-gray-200' : 'text-gray-500'}`}>
                            {item.label}
                          </span>
                          {isFailed && (
                            <span className="text-[9px] bg-red-900/40 text-red-400 border border-red-700/40 rounded px-1.5 py-0.5">
                              {st === 'missing' ? 'Model Missing' : 'Load Failed'}
                            </span>
                          )}
                          {st === 'pending' && (
                            <span className="text-[9px] bg-gray-800 text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">Phase-2</span>
                          )}
                        </div>
                        <p className="text-[10px] text-gray-500 mt-0.5">{item.desc}</p>
                        {item.model && (
                          <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
                            requires: {item.model}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => available && !isFailed && toggleModule(item.id)}
                        disabled={!available || isFailed || isSaving || st === 'pending'}
                        className={`flex-shrink-0 ml-4 w-11 h-6 rounded-full relative transition-colors disabled:opacity-30 ${
                          isOn ? 'bg-green-600' : 'bg-gray-700'
                        }`}
                        title={isOn ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                      >
                        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all ${isOn ? 'left-6' : 'left-1'}`} />
                        {isSaving && (
                          <span className="absolute inset-0 flex items-center justify-center text-[8px] text-white animate-pulse">…</span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-3 text-[10px] text-gray-600">
          Full module list (COCO 80-class accessories, animals, indoor objects) is available in the
          Analytics panel (left sidebar → 🤖 Analytics tab).
        </p>
      </div>
    </div>
  );
}

// ── Section: System Health ────────────────────────────────────────────────────

interface SystemInfo {
  cpu:     { usagePct: number | null; cores: number; model: string | null };
  memory:  { totalBytes: number; freeBytes: number; usedPct: number; processRss: number; processHeap: number };
  gpu:     Array<{ index: number; utilization: number; memUsed: number; memTotal: number }> | null;
  diskIo:  { readBps: number; writeBps: number } | null;
  storage: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number | null; path: string } | null;
}

interface DbInfo {
  mode:      'mongodb' | 'json';
  connected: boolean;
  rates:     { insertsPerSec: number; updatesPerSec: number; deletesPerSec: number; findsPerSec: number; totalPerSec: number };
  cumulative:{ inserts: number; updates: number; deletes: number; finds: number };
}

function fmtBytes(b: number): string {
  if (b >= 1e12) return (b / 1e12).toFixed(1) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(1)  + ' GB';
  if (b >= 1e6)  return (b / 1e6).toFixed(1)  + ' MB';
  if (b >= 1e3)  return (b / 1e3).toFixed(0)  + ' KB';
  return b + ' B';
}

function fmtBps(bps: number): string {
  if (bps >= 1e9) return (bps / 1e9).toFixed(1) + ' GB/s';
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' KB/s';
  return bps + ' B/s';
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function GaugeBar({ pct, color = 'blue' }: { pct: number | null; color?: string }) {
  const colorMap: Record<string, string> = {
    blue:   'bg-blue-500',
    green:  'bg-green-500',
    yellow: 'bg-yellow-500',
    red:    'bg-red-500',
    purple: 'bg-purple-500',
  };
  const barColor = pct !== null && pct > 85 ? 'bg-red-500'
                 : pct !== null && pct > 65 ? 'bg-yellow-500'
                 : (colorMap[color] ?? 'bg-blue-500');
  return (
    <div className="h-1.5 rounded-full bg-gray-700 overflow-hidden mt-1.5">
      <div
        className={`h-full rounded-full transition-all duration-700 ${barColor}`}
        style={{ width: pct !== null ? `${Math.min(100, pct)}%` : '0%' }}
      />
    </div>
  );
}

function MetricCard({ title, value, sub, pct, color = 'blue', children }: {
  title: string; value: string; sub?: string; pct?: number | null; color?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-1">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">{title}</div>
      <div className="text-xl font-bold text-white">{value}</div>
      {sub  && <div className="text-xs text-gray-400">{sub}</div>}
      {pct !== undefined && <GaugeBar pct={pct ?? null} color={color} />}
      {children}
    </div>
  );
}

function SystemSection({ apiFetch }: { apiFetch: (path: string, opts?: RequestInit) => Promise<unknown> }) {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [dbInfo,     setDbInfo]     = useState<DbInfo | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/admin/system') as { system: SystemInfo; db: DbInfo };
      setSystemInfo(data.system);
      setDbInfo(data.db);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apiFetch]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 3000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  const sys = systemInfo;
  const db  = dbInfo;

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">System Health</h2>
          <p className="text-sm text-gray-500 mt-0.5">CPU · Memory · Disk I/O · DB — auto-refreshes every 3s</p>
        </div>
        {sys && (
          <span className="text-[10px] text-gray-500 font-mono">
            uptime {Math.floor(performance.now() / 1000)}s (client)
          </span>
        )}
      </div>

      {error && <ErrorBar msg={error} />}

      {/* ── Resource gauges ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">

        {/* CPU */}
        <MetricCard
          title="CPU"
          value={sys ? (sys.cpu.usagePct !== null ? `${sys.cpu.usagePct}%` : '—') : '…'}
          sub={sys ? `${sys.cpu.cores} cores` + (sys.cpu.model ? ` · ${sys.cpu.model.slice(0, 28)}` : '') : undefined}
          pct={sys?.cpu.usagePct}
          color="blue"
        />

        {/* Memory */}
        <MetricCard
          title="Memory"
          value={sys ? `${sys.memory.usedPct}%` : '…'}
          sub={sys ? `${fmtBytes(sys.memory.totalBytes - sys.memory.freeBytes)} / ${fmtBytes(sys.memory.totalBytes)}` : undefined}
          pct={sys?.memory.usedPct}
          color="purple"
        >
          {sys && (
            <div className="text-[10px] text-gray-500 mt-1">
              Process RSS {fmtBytes(sys.memory.processRss)} · Heap {fmtBytes(sys.memory.processHeap)}
            </div>
          )}
        </MetricCard>

        {/* GPU */}
        {sys?.gpu && sys.gpu.length > 0 ? (
          <MetricCard
            title={`GPU × ${sys.gpu.length}`}
            value={`${sys.gpu[0].utilization}%`}
            sub={`${fmtBytes(sys.gpu[0].memUsed * 1024 * 1024)} / ${fmtBytes(sys.gpu[0].memTotal * 1024 * 1024)}`}
            pct={sys.gpu[0].utilization}
            color="green"
          >
            {sys.gpu.length > 1 && (
              <div className="text-[10px] text-gray-500 mt-1">
                {sys.gpu.slice(1).map(g => `GPU${g.index}: ${g.utilization}%`).join(' · ')}
              </div>
            )}
          </MetricCard>
        ) : (
          <MetricCard title="GPU" value="—" sub="No NVIDIA GPU detected" />
        )}

        {/* Storage capacity */}
        <MetricCard
          title="Storage"
          value={sys?.storage ? `${sys.storage.usedPct ?? '?'}%` : '—'}
          sub={sys?.storage
            ? `${fmtBytes(sys.storage.usedBytes)} / ${fmtBytes(sys.storage.totalBytes)}`
            : undefined}
          pct={sys?.storage?.usedPct ?? null}
          color="yellow"
        >
          {sys?.storage && (
            <div className="text-[10px] text-gray-500 mt-1 truncate" title={sys.storage.path}>
              {sys.storage.path}
            </div>
          )}
        </MetricCard>
      </div>

      {/* ── Disk I/O ─────────────────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Disk I/O</div>
        {sys?.diskIo ? (
          <div className="grid grid-cols-2 gap-4">
            {([['Read', sys.diskIo.readBps, 'blue'], ['Write', sys.diskIo.writeBps, 'yellow']] as const).map(([label, bps, color]) => {
              const MAX_BPS = 500 * 1024 * 1024; // 500 MB/s scale
              const pct = Math.min(100, Math.round((bps / MAX_BPS) * 100));
              return (
                <div key={label}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-400">{label}</span>
                    <span className="font-mono text-white">{fmtBps(bps)}</span>
                  </div>
                  <GaugeBar pct={pct} color={color} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-gray-600">Disk I/O data unavailable (Linux /proc/diskstats only)</div>
        )}
      </div>

      {/* ── Database ─────────────────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Database</div>
        {db ? (
          <div className="space-y-3">
            {/* Mode + connection */}
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-white capitalize">{db.mode}</span>
              <span className={`flex items-center gap-1.5 text-xs font-medium ${db.connected ? 'text-green-400' : 'text-red-400'}`}>
                <span className={`w-2 h-2 rounded-full ${db.connected ? 'bg-green-400' : 'bg-red-400'}`} />
                {db.connected ? 'Connected' : 'Disconnected'}
              </span>
              {!db.connected && db.mode === 'mongodb' && (
                <span className="text-[10px] text-yellow-500">⚠ Falling back to lts.json</span>
              )}
            </div>

            {/* Rates */}
            <div>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-2xl font-bold text-white">{db.rates.totalPerSec}</span>
                <span className="text-xs text-gray-400">queries/sec</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {([
                  ['Insert', db.rates.insertsPerSec, 'text-blue-400'],
                  ['Update', db.rates.updatesPerSec, 'text-yellow-400'],
                  ['Delete', db.rates.deletesPerSec, 'text-red-400'],
                  ['Find',   db.rates.findsPerSec,   'text-green-400'],
                ] as const).map(([label, val, cls]) => (
                  <div key={label} className="bg-gray-800 rounded-lg p-2 text-center">
                    <div className={`text-base font-bold ${cls}`}>{val}</div>
                    <div className="text-[10px] text-gray-500">{label}/s</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Cumulative */}
            <div className="border-t border-gray-800 pt-2 grid grid-cols-4 gap-2 text-[11px]">
              {([
                ['Total inserts', db.cumulative.inserts],
                ['Total updates', db.cumulative.updates],
                ['Total deletes', db.cumulative.deletes],
                ['Total finds',   db.cumulative.finds],
              ] as const).map(([label, val]) => (
                <div key={label}>
                  <div className="text-gray-300 font-mono">{fmtNum(val)}</div>
                  <div className="text-gray-600">{label}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-600">Loading…</div>
        )}
      </div>
    </div>
  );
}

// ── Section: WebRTC / ICE ──────────────────────────────────────────────────────
//
// STUN/TURN servers and the ICE connectivity test used to live in the per-dashboard
// Settings modal (client/src/App.tsx SettingsModal). They moved here so streaming
// and analysis servers manage them centrally, leaving only Language in that modal.
// combined-mode servers still keep a quick-access copy in the modal too — this
// section and that modal both read/write the same webrtcConfigStore, so edits
// made here take effect immediately in both places.

function WebRTCSection() {
  const webrtcStore = useWebRTCConfigStore();

  const [enabled,  setEnabled]  = useState(webrtcStore.enabled);
  const [stunUrls, setStunUrls] = useState<string[]>(webrtcStore.stunUrls);
  const [turns,    setTurns]    = useState<TurnServer[]>(webrtcStore.turns ?? []);
  const [saved,    setSaved]    = useState(false);

  const [iceRunning,    setIceRunning]    = useState(false);
  const [iceLog,        setIceLog]        = useState<string[]>([]);
  const [iceFailedUrls, setIceFailedUrls] = useState<string[]>([]);
  const iceLogRef   = useRef<HTMLTextAreaElement>(null);
  const iceAbortRef = useRef(false);

  function updateStun(idx: number, value: string) {
    setStunUrls((prev) => prev.map((u, i) => (i === idx ? value : u)));
    setSaved(false);
  }
  function addStun() {
    setStunUrls((prev) => [...prev, '']);
    setSaved(false);
  }
  function removeStun(idx: number) {
    setStunUrls((prev) => prev.filter((_, i) => i !== idx));
    setSaved(false);
  }

  function updateTurn(idx: number, field: 'url' | 'username' | 'credential', value: string) {
    setTurns((prev) => prev.map((tv, i) => i === idx ? { ...tv, [field]: value } : tv));
    setSaved(false);
  }
  function addTurn() {
    setTurns((prev) => [...prev, { url: '', username: '', credential: '' }]);
    setSaved(false);
  }
  function removeTurn(idx: number) {
    setTurns((prev) => prev.filter((_, i) => i !== idx));
    setSaved(false);
  }

  function handleApply() {
    const cfg: WebRTCConfig = {
      enabled,
      stunUrls: stunUrls.map((u) => u.trim()).filter(Boolean),
      turns: turns.filter((tv) => tv.url.trim()),
    };
    webrtcStore.setConfig(cfg);
    setSaved(true);
  }

  async function runIceTest() {
    setIceRunning(true);
    setIceFailedUrls([]);
    iceAbortRef.current = false;
    const lines: string[] = [];
    const ts = () => new Date().toISOString().slice(11, 23);
    const log = (msg: string) => {
      lines.push(`[${ts()}] ${msg}`);
      setIceLog([...lines]);
      requestAnimationFrame(() => {
        if (iceLogRef.current) iceLogRef.current.scrollTop = iceLogRef.current.scrollHeight;
      });
    };

    try {
      const iceServers: RTCIceServer[] = [
        ...stunUrls.map(u => u.trim()).filter(Boolean).map(urls => ({ urls })),
        ...turns.filter(tv => tv.url.trim()).map(tv => ({
          urls: tv.url.trim(), username: tv.username, credential: tv.credential,
        })),
      ];

      log('=== Phase 1: ICE Candidate Gathering ===');
      log(`STUN servers  : ${stunUrls.filter(Boolean).join(', ') || '(none)'}`);
      log(`TURN servers  : ${turns.filter(tv => tv.url).map(tv => tv.url).join(', ') || '(none)'}`);
      log(`Total ICE servers: ${iceServers.length}`);

      const pc = new RTCPeerConnection({ iceServers });
      pc.createDataChannel('lts-ice-check');

      const gathered: RTCIceCandidate[] = [];
      const failedUrls: string[] = [];

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          log('  Gathering timed out after 15 s');
          log('  ⚠ Timeout caused by unreachable ICE servers — remove them to fix stream instability');
          resolve();
        }, 15_000);

        pc.onicecandidate = (e) => {
          if (!e.candidate) return;
          gathered.push(e.candidate);
          const c = e.candidate;
          log(`  + ${c.type?.padEnd(5)} ${c.address}:${c.port}  proto=${c.protocol}`);
        };

        pc.onicecandidateerror = (e) => {
          const err = e as RTCPeerConnectionIceErrorEvent;
          log(`  ! ICE error: code=${err.errorCode} url=${err.url} "${err.errorText}"`);
          if (err.errorCode >= 700 && err.url) failedUrls.push(err.url);
        };

        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        };

        pc.createOffer()
          .then(offer => pc.setLocalDescription(offer))
          .catch(err => { log(`  Offer error: ${err.message}`); clearTimeout(timer); resolve(); });
      });

      pc.close();

      const dedupedFailed = [...new Set(failedUrls)];
      if (dedupedFailed.length > 0) setIceFailedUrls(dedupedFailed);

      const hostN  = gathered.filter(c => c.type === 'host').length;
      const srflxN = gathered.filter(c => c.type === 'srflx').length;
      const relayN = gathered.filter(c => c.type === 'relay').length;

      log('');
      log('--- Phase 1 Summary ---');
      log(`  host  (local)   : ${hostN}`);
      log(`  srflx (STUN)    : ${srflxN}  ${srflxN > 0 ? '✓ STUN reachable' : '✗ STUN unreachable or no STUN configured'}`);
      log(`  relay (TURN)    : ${relayN}  ${relayN > 0 ? '✓ TURN reachable' : turns.length > 0 ? '✗ TURN unreachable' : '(no TURN configured)'}`);
      if (dedupedFailed.length > 0) {
        log(`  ⚠ ${dedupedFailed.length} unreachable server(s) — causes ${dedupedFailed.length * 5}–15 s gather delay on every WebRTC connect`);
      }

      if (iceAbortRef.current) { log('Aborted.'); return; }

      log('');
      log('=== Phase 2: WebRTC Engine ===');

      try {
        const resp = await fetch('/api/webrtc/ice-test', { method: 'POST' });
        const contentType = resp.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
          log(`  ✗ Server returned non-JSON (HTTP ${resp.status}) — restart the server and try again`);
        } else {
          const data = await resp.json();
          if (!resp.ok || data.error) {
            const engineName = data.engine ?? 'webrtc';
            log(`  ✗ Engine unreachable [${engineName}]: ${data.error ?? `HTTP ${resp.status}`}`);
            if (data.hint) log(`    → ${data.hint}`);
          } else {
            const engineLabel = data.engine ?? 'webrtc';
            const portInfo    = data.udpPort ? `  UDP port=${data.udpPort}` : '';
            log(`  ✓ Engine ready  engine=${engineLabel}${portInfo}`);
          }
        }
      } catch (err: unknown) {
        log(`  ✗ Request failed: ${(err as Error).message}`);
      }
    } finally {
      setIceRunning(false);
    }
  }

  function downloadIceReport() {
    const text = iceLog.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ice-test-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputCls = 'w-full bg-gray-800 text-xs text-gray-200 px-2.5 py-1.5 rounded-lg border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-600';

  return (
    <div className="p-6 max-w-2xl">
      <SectionHeader title="WebRTC / ICE" subtitle="STUN/TURN servers and ICE connectivity — shared with the dashboard's quick settings" />

      {/* WebRTC configuration panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm text-gray-300">Enable WebRTC</span>
          <button
            onClick={() => { setEnabled((v) => !v); setSaved(false); }}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ${
              enabled ? 'bg-blue-600' : 'bg-gray-600'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
        </div>

        {/* STUN servers */}
        <p className="text-xs text-gray-500 mb-1">STUN Servers</p>
        <div className="space-y-1 mb-1">
          {stunUrls.map((url, idx) => (
            <div key={idx} className="flex gap-1.5 items-center">
              <input
                value={url}
                onChange={(e) => updateStun(idx, e.target.value)}
                placeholder="stun:stun.l.google.com:19302"
                className={inputCls + ' flex-1'}
              />
              <button onClick={() => removeStun(idx)} className="text-gray-500 hover:text-red-400 transition-colors px-1 text-lg leading-none" title="Remove">×</button>
            </div>
          ))}
        </div>
        <button onClick={addStun} className="text-xs text-blue-400 hover:text-blue-300 transition-colors mb-4">+ Add</button>

        {/* TURN servers */}
        <p className="text-xs text-gray-500 mb-1">TURN Servers</p>
        <div className="space-y-2 mb-1">
          {turns.map((turn, idx) => (
            <div key={idx} className="space-y-1 bg-gray-950/60 border border-gray-800 rounded-lg p-2.5">
              <div className="flex gap-1.5 items-center">
                <input
                  value={turn.url}
                  onChange={(e) => updateTurn(idx, 'url', e.target.value)}
                  placeholder="turn:your-server:3478"
                  className={inputCls + ' flex-1'}
                />
                <button onClick={() => removeTurn(idx)} className="text-gray-500 hover:text-red-400 transition-colors px-1 text-lg leading-none flex-shrink-0" title="Remove">×</button>
              </div>
              <div className="flex gap-1.5">
                <input
                  value={turn.username}
                  onChange={(e) => updateTurn(idx, 'username', e.target.value)}
                  placeholder="Username"
                  className={inputCls + ' flex-1'}
                />
                <input
                  value={turn.credential}
                  onChange={(e) => updateTurn(idx, 'credential', e.target.value)}
                  placeholder="Credential"
                  type="password"
                  autoComplete="new-password"
                  className={inputCls + ' flex-1'}
                />
              </div>
            </div>
          ))}
        </div>
        <button onClick={addTurn} className="text-xs text-blue-400 hover:text-blue-300 transition-colors mb-4">+ Add</button>

        <button
          onClick={handleApply}
          className={`w-full py-2 rounded-lg text-xs font-semibold transition-colors ${
            saved ? 'bg-green-700/60 text-green-300 cursor-default' : 'bg-blue-700 hover:bg-blue-600 text-white'
          }`}
        >
          {saved ? 'Saved ✓' : 'Apply'}
        </button>
      </div>

      {/* ICE connectivity test panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">ICE Connectivity Test</h3>
          {iceLog.length > 0 && (
            <div className="flex gap-1">
              <button onClick={downloadIceReport} className="text-[10px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors">Download Report</button>
              <button onClick={() => setIceLog([])} className="text-[10px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors">Clear</button>
            </div>
          )}
        </div>

        <button
          onClick={iceRunning ? () => { iceAbortRef.current = true; } : runIceTest}
          className={`w-full py-2 rounded-lg text-xs font-semibold transition-colors mb-3 ${
            iceRunning ? 'bg-yellow-700/70 text-yellow-200 hover:bg-yellow-700' : 'bg-indigo-700 hover:bg-indigo-600 text-white'
          }`}
        >
          {iceRunning ? 'Testing… (click to abort)' : 'Run ICE Test'}
        </button>

        {iceFailedUrls.length > 0 && (
          <div className="bg-yellow-900/40 border border-yellow-700/60 rounded-lg px-3 py-2 mb-3 text-[10px] text-yellow-300">
            <div className="font-semibold mb-1">⚠ {iceFailedUrls.length} server(s) unreachable (causes gather delay)</div>
            {iceFailedUrls.map(u => <div key={u} className="font-mono text-yellow-400/80">{u}</div>)}
            <button
              onClick={() => {
                setStunUrls(prev => prev.filter(u => !iceFailedUrls.includes(u.trim())));
                setTurns(prev => prev.filter(tv => !iceFailedUrls.includes(tv.url.trim())));
                setIceFailedUrls([]);
                setSaved(false);
              }}
              className="mt-1.5 px-2 py-0.5 bg-yellow-700 hover:bg-yellow-600 text-white rounded text-[10px] font-semibold"
            >
              Remove unreachable servers
            </button>
          </div>
        )}

        {iceLog.length > 0 && (
          <textarea
            ref={iceLogRef}
            readOnly
            value={iceLog.join('\n')}
            title="ICE Test Log"
            className="w-full h-48 bg-black/60 text-[10px] font-mono text-green-300 px-2.5 py-2 rounded-lg border border-gray-800 resize-none focus:outline-none"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
