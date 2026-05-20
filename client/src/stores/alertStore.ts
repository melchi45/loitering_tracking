import { create } from 'zustand';
import type { Alert } from '../types';

function normalizeTs(ts: number | string | undefined): number {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  const t = new Date(ts).getTime();
  return isNaN(t) ? 0 : t;
}

interface AlertStore {
  alerts: Alert[];
  addAlert: (alert: Alert) => void;
  hydrateAlerts: (alerts: Alert[]) => void;
  acknowledgeAlert: (id: string) => void;
  clearAlerts: () => void;
}

export const useAlertStore = create<AlertStore>((set) => ({
  alerts: [],

  addAlert: (alert) =>
    set((state) => {
      if (state.alerts.find((a) => a.id === alert.id)) return state;
      const newAlerts = [alert, ...state.alerts].slice(0, 200);
      return { alerts: newAlerts };
    }),

  hydrateAlerts: (incoming) =>
    set((state) => {
      const existing = new Map(state.alerts.map((a) => [a.id, a]));
      for (const a of incoming) {
        if (!existing.has(a.id)) existing.set(a.id, a);
      }
      const merged = [...existing.values()].sort(
        (a, b) => normalizeTs(b.timestamp) - normalizeTs(a.timestamp)
      ).slice(0, 500);
      return { alerts: merged };
    }),

  acknowledgeAlert: (id) =>
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id ? { ...a, acknowledged: true } : a
      ),
    })),

  clearAlerts: () => set({ alerts: [] }),
}));
