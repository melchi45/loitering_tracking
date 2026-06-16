import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useOnvifEventStore, type OnvifEventType } from '../../stores/onvifEventStore';
import { useSocket } from '../../hooks/useSocket';

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

type StatusFilter = 'all' | 'pending' | 'active' | 'rejected' | 'revoked';
type AdminSection = 'users' | 'onvif' | 'audit';

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
  { id: 'users', label: 'Users',      icon: '👥', desc: 'Manage user accounts & roles' },
  { id: 'onvif', label: 'ONVIF',      icon: '📡', desc: 'Event type registry' },
  { id: 'audit', label: 'Audit Log',  icon: '📋', desc: 'Activity history' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  const { accessToken, navigateTo } = useAuthStore();
  const [section, setSection] = useState<AdminSection>('users');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') navigateTo('dashboard'); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigateTo]);

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
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

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
          {NAV.map(item => (
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

        {/* Content */}
        <main className="flex-1 overflow-y-auto bg-gray-950">
          {section === 'users' && <UsersSection apiFetch={apiFetch} />}
          {section === 'onvif' && <OnvifSection apiFetch={apiFetch} />}
          {section === 'audit' && <AuditSection apiFetch={apiFetch} />}
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

function AuditSection({ apiFetch }: { apiFetch: (p: string, o?: RequestInit) => Promise<unknown> }) {
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
    <div className="p-6">
      <SectionHeader title="Audit Log" subtitle="Recent system activity and administrative actions (latest 200 entries)" />

      <div className="flex items-center gap-3 mb-5">
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
        <EmptyState msg={search ? `No entries matching "${search}".` : 'No audit entries found.'} />
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

function StatCard({ label, value, color }: { label: string; value: number; color: 'blue' | 'red' | 'yellow' }) {
  const colors = {
    blue:   'bg-blue-900/20 border-blue-800/40 text-blue-400',
    red:    'bg-red-900/20  border-red-800/40  text-red-400',
    yellow: 'bg-yellow-900/20 border-yellow-800/40 text-yellow-400',
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
