import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';

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
}

type StatusFilter = 'all' | 'pending' | 'active' | 'rejected' | 'revoked';

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

export default function AdminUsersPage() {
  const { accessToken, navigateTo } = useAuthStore();
  const [users, setUsers]         = useState<User[]>([]);
  const [filter, setFilter]       = useState<StatusFilter>('all');
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [actionId, setActionId]   = useState<string | null>(null);

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

  async function loadUsers() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (search)           params.set('search', search);
      const data = await apiFetch(`/admin/users?${params}`);
      setUsers(data.users ?? []);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadUsers(); }, [filter, search]);

  async function handleAction(userId: string, action: string, role?: string) {
    setActionId(userId);
    try {
      await apiFetch(`/admin/users/${userId}`, {
        method: 'PATCH',
        body:   JSON.stringify({ action, role }),
      });
      await loadUsers();
    } catch (e: unknown) {
      alert((e as Error).message);
    } finally {
      setActionId(null);
    }
  }

  async function handleDelete(userId: string, email: string) {
    if (!confirm(`Delete user ${email}? This cannot be undone.`)) return;
    setActionId(userId);
    try {
      await apiFetch(`/admin/users/${userId}`, { method: 'DELETE' });
      await loadUsers();
    } catch (e: unknown) {
      alert((e as Error).message);
    } finally {
      setActionId(null);
    }
  }

  const fmt = (s: string | null) => s ? new Date(s).toLocaleDateString() : '—';

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center justify-between">
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
          <h1 className="text-lg font-semibold">User Management</h1>
          <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full">Admin</span>
        </div>
        <button
          onClick={() => navigateTo('dashboard')}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >Dashboard →</button>
      </header>

      <div className="max-w-6xl mx-auto p-6">
        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-6">
          <div className="flex bg-gray-800 rounded-lg p-1 gap-1">
            {(['all', 'pending', 'active', 'rejected', 'revoked'] as StatusFilter[]).map(s => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                  filter === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >{s}</button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by email or name…"
            className="flex-1 min-w-[200px] bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded-lg text-red-300 text-sm">{error}</div>
        )}

        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading…</div>
        ) : users.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No users found.</div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wide">
                  <th className="text-left px-5 py-3">User</th>
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
                      <div className="font-medium text-white">{u.name || u.email}</div>
                      <div className="text-gray-500 text-xs">{u.email}</div>
                    </td>
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
                            <button onClick={() => handleAction(u.id, 'approve')}
                              disabled={actionId === u.id}
                              className="px-2.5 py-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded text-xs font-medium">
                              Approve
                            </button>
                            <button onClick={() => handleAction(u.id, 'reject')}
                              disabled={actionId === u.id}
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
                              title="Change role"
                            >
                              <option value="admin">admin</option>
                              <option value="operator">operator</option>
                              <option value="viewer">viewer</option>
                            </select>
                            <button onClick={() => handleAction(u.id, 'revoke')}
                              disabled={actionId === u.id}
                              className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded text-xs font-medium">
                              Revoke
                            </button>
                          </>
                        )}
                        {(u.status === 'rejected' || u.status === 'revoked') && (
                          <button onClick={() => handleAction(u.id, 'reactivate')}
                            disabled={actionId === u.id}
                            className="px-2.5 py-1 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white rounded text-xs font-medium">
                            Reactivate
                          </button>
                        )}
                        <button onClick={() => handleDelete(u.id, u.email)}
                          disabled={actionId === u.id}
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
    </div>
  );
}
