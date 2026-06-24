import { create } from 'zustand';

export type OnvifSeverity = 'info' | 'warning' | 'critical';

export interface OnvifEvent {
  id: string;
  cameraId: string;
  topic: string;
  topicType: string;
  topicLabel: string;
  severity: OnvifSeverity;
  utcTime: string;
  operation: string;
  sourceToken: string | null;
  ruleName: string | null;
  state: string | null;
  items: Record<string, string>;
  rawXml: string | null;
  rawPayload?: string;
  serverTs: string;
  createdAt?: string;
}

/** Global registry of every ONVIF event type ever encountered. */
export interface OnvifEventType {
  id: string;
  topicType: string;
  topicLabel: string;
  topic: string;
  severity: OnvifSeverity;
  firstSeenAt: string;
}

interface OnvifEventStore {
  events: OnvifEvent[];
  /** All ever-seen ONVIF event types (global registry, loaded from /api/onvif-event-types) */
  types: OnvifEventType[];

  /** Prepend a Socket.IO live event (newest first) */
  pushEvent: (evt: OnvifEvent) => void;
  /** Replace store with events fetched from REST API */
  setEvents: (evts: OnvifEvent[]) => void;
  clearAll: () => void;

  /** Replace type registry with data fetched from REST API */
  setTypes: (types: OnvifEventType[]) => void;
  /** Add a single type emitted via onvif:type-registered (no-op if already present) */
  addType: (type: OnvifEventType) => void;
  /** Clear all registered types (admin reset) */
  clearTypes: () => void;
}

export const useOnvifEventStore = create<OnvifEventStore>((set) => ({
  events: [],
  types:  [],

  pushEvent: (evt) =>
    set((s) => {
      // Dedup by id
      if (s.events.some((e) => e.id === evt.id)) return s;
      const items = typeof evt.items === 'string'
        ? JSON.parse(evt.items as unknown as string)
        : (evt.items ?? {});
      const rawXml = evt.rawPayload
        ? (() => { try { return atob(evt.rawPayload!); } catch { return null; } })()
        : evt.rawXml ?? null;
      const next: OnvifEvent = { ...evt, items, rawXml };
      return { events: [next, ...s.events].slice(0, 10000) };
    }),

  setEvents: (evts) =>
    set({
      events: evts.map(evt => {
        const items = typeof evt.items === 'string'
          ? (() => { try { return JSON.parse(evt.items as unknown as string); } catch { return {}; } })()
          : (evt.items ?? {});
        const rawXml = evt.rawXml ?? (evt.rawPayload
          ? (() => { try { return atob(evt.rawPayload!); } catch { return null; } })()
          : null);
        return { ...evt, items, rawXml };
      }),
    }),
  clearAll:  ()     => set({ events: [] }),

  setTypes: (types) => set({ types }),

  addType: (type) =>
    set((s) => {
      if (s.types.some((t) => t.topicType === type.topicType)) return s;
      return { types: [...s.types, type].sort((a, b) => a.topicLabel.localeCompare(b.topicLabel)) };
    }),

  clearTypes: () => set({ types: [] }),
}));
