import { create } from 'zustand';

export type UserRole = 'admin' | 'operator' | 'viewer';
export type UserStatus = 'active' | 'pending' | 'rejected' | 'revoked';
export type AppPage = 'signin' | 'pending' | 'dashboard' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  loginCount: number;
  organization?: string;
  phone?: string;
  bio?: string;
  avatarDataUrl?: string;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  page: AppPage;
  loading: boolean;
  error: string | null;
  // Section id to pre-select the next time AdminUsersPage mounts (2026-07-21)
  // — e.g. the Streaming Dashboard's Ingest-Daemon status badge sets this to
  // 'ingest' before navigateTo('admin'). AdminUsersPage reads and clears it
  // on mount so a later manual section switch isn't overridden on remount.
  // A plain string (not AdminSection) since that type lives in the admin
  // page module, not shared — avoids a cross-import just for this.
  pendingAdminSection: string | null;

  // Actions
  register: (email: string, password: string, name?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  navigateTo: (page: AppPage) => void;
  setPendingAdminSection: (section: string | null) => void;
  clearError: () => void;
  setError: (msg: string | null) => void;
  updateProfile: (fields: {
    name?: string;
    organization?: string;
    phone?: string;
    bio?: string;
    avatarDataUrl?: string;
  }) => Promise<void>;
}

const BASE = '';  // same origin — proxy or direct HTTPS

async function apiFetch(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user:        null,
  accessToken: null,
  page:        'signin',
  loading:     false,
  error:       null,
  pendingAdminSection: null,

  navigateTo: (page) => set({ page }),
  setPendingAdminSection: (section) => set({ pendingAdminSection: section }),
  clearError: ()     => set({ error: null }),
  setError:   (msg)  => set({ error: msg }),

  register: async (email, password, name) => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch('/auth/register', {
        method: 'POST',
        body:   JSON.stringify({ email, password, name }),
      });
      if (data.status === 'pending') {
        set({ user: data.user, accessToken: null, page: 'pending', loading: false });
      } else {
        set({ user: data.user, accessToken: data.accessToken, page: 'dashboard', loading: false });
      }
    } catch (err: unknown) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body:   JSON.stringify({ email, password }),
      });
      const page: AppPage =
        data.user.status === 'pending' ? 'pending' : 'dashboard';
      set({ user: data.user, accessToken: data.accessToken, page, loading: false });
    } catch (err: unknown) {
      const msg = (err as Error).message;
      // If pending, redirect to pending page
      if (msg.includes('pending')) {
        set({ loading: false, error: null, page: 'pending' });
      } else {
        set({ loading: false, error: msg });
      }
    }
  },

  logout: async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {}
    set({ user: null, accessToken: null, page: 'signin' });
  },

  refresh: async () => {
    try {
      const data = await apiFetch('/auth/refresh', { method: 'POST' });
      set({ accessToken: data.accessToken });
      // Also re-fetch /auth/me to get latest user data
      const userData = await apiFetch('/auth/me', {
        headers: { Authorization: `Bearer ${data.accessToken}` },
      });
      const page: AppPage = get().page === 'signin' ? 'dashboard' : get().page;
      set({ user: userData, page });
      return true;
    } catch {
      set({ user: null, accessToken: null, page: 'signin' });
      return false;
    }
  },

  updateProfile: async (fields) => {
    const { accessToken } = get();
    const updated = await apiFetch('/auth/me', {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${accessToken}` },
      body:    JSON.stringify(fields),
    });
    set({ user: updated });
  },
}));
