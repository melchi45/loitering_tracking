import { create } from 'zustand';
import type { Alert } from '../types';

interface AlertStore {
  alerts: Alert[];
  addAlert: (alert: Alert) => void;
  acknowledgeAlert: (id: string) => void;
  clearAlerts: () => void;
}

export const useAlertStore = create<AlertStore>((set) => ({
  alerts: [],

  addAlert: (alert) =>
    set((state) => {
      // Keep newest first, limit to 100 stored alerts
      const newAlerts = [alert, ...state.alerts].slice(0, 100);
      return { alerts: newAlerts };
    }),

  acknowledgeAlert: (id) =>
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id ? { ...a, acknowledged: true } : a
      ),
    })),

  clearAlerts: () => set({ alerts: [] }),
}));
