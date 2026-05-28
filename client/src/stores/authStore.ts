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
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  page: AppPage;
  loading: boolean;
  error: string | null;

  // Actions
  register: (email: string, password: string, name?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  navigateTo: (page: AppPage) => void;
  clearError: () => void;
  setError: (msg: string | null) => void;
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

  navigateTo: (page) => set({ page }),
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
}));
