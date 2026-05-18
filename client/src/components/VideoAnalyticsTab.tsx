import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

interface AttrItem  { id: string; label: string; labelKo: string; }
interface AttrGroup { groupKey: string; items: AttrItem[]; }

const GROUPS: AttrGroup[] = [
  {
    groupKey: 'zoneGroupPeopleVehicles',
    items: [
      { id: 'human',       label: 'Human',       labelKo: '사람'   },
      { id: 'vehicle',     label: 'Vehicle',     labelKo: '차량'   },
      { id: 'accessories', label: 'Accessories', labelKo: '소품'   },
    ],
  },
  {
    groupKey: 'zoneGroupAiAttributes',
    items: [
      { id: 'face',  label: 'Face',  labelKo: '얼굴'   },
      { id: 'mask',  label: 'Mask',  labelKo: '마스크' },
      { id: 'color', label: 'Color', labelKo: '색상'   },
      { id: 'cloth', label: 'Cloth', labelKo: '의류'   },
      { id: 'hat',   label: 'Hat',   labelKo: '모자'   },
    ],
  },
  {
    groupKey: 'zoneGroupHazards',
    items: [
      { id: 'fire',  label: 'Fire',  labelKo: '화재' },
      { id: 'smoke', label: 'Smoke', labelKo: '연기' },
    ],
  },
  {
    groupKey: 'zoneGroupIndoor',
    items: [
      { id: 'chair',       label: 'Chair',      labelKo: '의자'      },
      { id: 'diningtable', label: 'Desk/Table', labelKo: '책상/탁자' },
      { id: 'laptop',      label: 'Laptop',     labelKo: '노트북'    },
      { id: 'tv',          label: 'TV/Monitor', labelKo: 'TV/모니터' },
      { id: 'keyboard',    label: 'Keyboard',   labelKo: '키보드'    },
      { id: 'mouse',       label: 'Mouse',      labelKo: '마우스'    },
      { id: 'cellphone',   label: 'Phone',      labelKo: '휴대폰'    },
      { id: 'clock',       label: 'Clock',      labelKo: '시계'      },
      { id: 'cup',         label: 'Cup',        labelKo: '컵'        },
      { id: 'bottle',      label: 'Bottle',     labelKo: '병'        },
      { id: 'book',        label: 'Book',       labelKo: '책'        },
    ],
  },
];

export default function VideoAnalyticsTab() {
  const { t, lang } = useI18n();

  // enabled: current module on/off state
  const [enabled, setEnabled]   = useState<Record<string, boolean>>({});
  // caps: which modules have a model available
  const [caps, setCaps]         = useState<Record<string, boolean>>({});
  const [saving, setSaving]     = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/analytics/config').then(r => r.json()),
      fetch('/api/capabilities').then(r => r.json()),
    ])
      .then(([cfg, cap]) => {
        if (cfg.success) setEnabled(cfg.data);
        if (cap.ai)      setCaps(cap.ai);
      })
      .catch(() => setLoadError(true));
  }, []);

  const toggle = async (id: string) => {
    const next = !enabled[id];
    setEnabled(prev => ({ ...prev, [id]: next }));
    setSaving(id);
    try {
      await fetch('/api/analytics/config', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ [id]: next }),
      });
    } catch {
      // rollback
      setEnabled(prev => ({ ...prev, [id]: !next }));
    } finally {
      setSaving(null);
    }
  };

  const groupLabel = (key: string): string => {
    const k = key as keyof typeof t;
    return typeof t[k] === 'string' ? String(t[k]) : key;
  };

  if (loadError) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs text-red-400">Failed to load analytics config.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-700 flex-shrink-0">
        <h2 className="text-xs font-bold text-white uppercase tracking-wide">{t.tabVideoAnalytics}</h2>
        <p className="text-[10px] text-gray-500 mt-0.5">{t.videoAnalyticsHint}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {GROUPS.map((group) => (
          <div key={group.groupKey}>
            <div className="text-[9px] text-gray-500 uppercase tracking-wide font-bold mb-1.5">
              {groupLabel(group.groupKey)}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {group.items.map((item) => {
                const available  = caps[item.id] !== false;
                const isEnabled  = enabled[item.id] !== false;
                const isSaving   = saving === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => available && toggle(item.id)}
                    disabled={!available || isSaving}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] text-left transition-colors border ${
                      !available
                        ? 'opacity-35 cursor-not-allowed bg-gray-800 border-transparent text-gray-500'
                        : isEnabled
                        ? 'bg-blue-700/70 border-blue-500 text-white'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
                    }`}
                    title={!available ? 'Model not installed' : isEnabled ? 'Click to disable' : 'Click to enable'}
                  >
                    {/* Toggle indicator */}
                    <span className={`w-7 h-3.5 rounded-full flex-shrink-0 relative transition-colors ${
                      !available ? 'bg-gray-700' : isEnabled ? 'bg-blue-500' : 'bg-gray-600'
                    }`}>
                      <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-all ${
                        isEnabled ? 'left-3.5' : 'left-0.5'
                      }`} />
                    </span>
                    <span className="truncate">
                      {lang === 'ko' ? item.labelKo : item.label}
                    </span>
                    {isSaving && <span className="ml-auto text-[8px] text-blue-300 animate-pulse">…</span>}
                    {!available && <span className="ml-auto text-[8px] text-gray-600">N/A</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer hint */}
      <div className="px-3 py-2 border-t border-gray-700 flex-shrink-0">
        <p className="text-[9px] text-gray-600 leading-relaxed">{t.videoAnalyticsFooter}</p>
      </div>
    </div>
  );
}
