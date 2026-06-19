import { useEffect, useRef, useState } from 'react'; // eslint-disable-line
import { useI18n } from '../i18n';

interface AttrItem  { id: string; label: string; labelKo: string; model?: string; pending?: boolean; installHint?: string; }
interface AttrGroup { groupKey: string; items: AttrItem[]; }

interface FireSmokeConfig {
  confThreshold: number;
  nmsThreshold:  number;
}

const FIRE_SMOKE_DEFAULTS: FireSmokeConfig = { confThreshold: 0.35, nmsThreshold: 0.45 };

interface KalmanConfig {
  maxAge:             number;
  iouThreshold:       number;
  fastSpeedThreshold: number;
  fastQScale:         number;
  slowSpeedThreshold: number;
  slowQScale:         number;
  occlusionQScale:    number;
  measurementNoise:   number;
  iouWeight:          number;
  faceWeight:         number;
  colorWeight:        number;
  clothWeight:        number;
  accWeight:          number;
}

const KALMAN_DEFAULTS: KalmanConfig = {
  maxAge:             90,
  iouThreshold:       0.25,
  fastSpeedThreshold: 30,
  fastQScale:         4.0,
  slowSpeedThreshold: 5,
  slowQScale:         0.5,
  occlusionQScale:    3.0,
  measurementNoise:   10,
  iouWeight:          0.60,
  faceWeight:         0.20,
  colorWeight:        0.12,
  clothWeight:        0.05,
  accWeight:          0.03,
};

const KALMAN_SLIDERS: Array<{
  key: keyof KalmanConfig;
  label: string;
  hint: string;
  min: number; max: number; step: number; unit: string;
}> = [
  { key: 'maxAge',             label: 'Track Max Age',         hint: 'Frames before lost track is deleted (90=9s @ 10fps)',          min: 10,  max: 300, step: 10,   unit: ' fr'   },
  { key: 'iouThreshold',       label: 'IoU Match Threshold',   hint: 'Min combined score for re-association (lower = more stable IDs)', min: 0.1, max: 0.6, step: 0.05, unit: '' },
  { key: 'fastSpeedThreshold', label: 'Fast Speed Threshold',  hint: 'Speed above = fast motion',                                    min: 5,   max: 100, step: 1,    unit: ' px/f' },
  { key: 'fastQScale',         label: 'Fast Q Scale',          hint: 'Q × when fast (trust measurement)',                            min: 1.0, max: 10,  step: 0.5,  unit: '×'     },
  { key: 'slowSpeedThreshold', label: 'Slow Speed Threshold',  hint: 'Speed below = stationary',                                     min: 1,   max: 20,  step: 1,    unit: ' px/f' },
  { key: 'slowQScale',         label: 'Slow Q Scale',          hint: 'Q × when still (tighten)',                                     min: 0.1, max: 1.0, step: 0.05, unit: '×'     },
  { key: 'occlusionQScale',    label: 'Occlusion Q Scale',     hint: 'Q × during occlusion',                                         min: 1.0, max: 10,  step: 0.5,  unit: '×'     },
  { key: 'measurementNoise',   label: 'Measurement Noise (R)', hint: 'R↑ = trust prediction more, measurements less',               min: 1,   max: 50,  step: 1,    unit: ''      },
];

const APPEARANCE_SLIDERS: Array<{
  key: keyof KalmanConfig;
  label: string;
  hint: string;
  color: string;
  min: number; max: number; step: number;
}> = [
  { key: 'iouWeight',   label: 'IoU (λ_iou)',       hint: 'Spatial overlap — always active, baseline cue',            color: 'accent-blue-400',   min: 0.0, max: 1.0, step: 0.05 },
  { key: 'faceWeight',  label: 'Face (λ_face)',      hint: 'ArcFace cosine sim — active when face model is enabled',   color: 'accent-green-400',  min: 0.0, max: 1.0, step: 0.05 },
  { key: 'colorWeight', label: 'Color (λ_color)',    hint: 'Upper/lower body RGB distance — fast, no model needed',    color: 'accent-yellow-400', min: 0.0, max: 1.0, step: 0.05 },
  { key: 'clothWeight', label: 'Cloth (λ_cloth)',    hint: 'PAR cloth-type match — active when openpar.onnx is loaded',color: 'accent-orange-400', min: 0.0, max: 1.0, step: 0.05 },
  { key: 'accWeight',   label: 'Accessories (λ_acc)','hint': 'Hat/Mask presence — active when PPE model is enabled',  color: 'accent-purple-400', min: 0.0, max: 1.0, step: 0.05 },
];

const GROUPS: AttrGroup[] = [
  {
    groupKey: 'zoneGroupPeopleVehicles',
    items: [
      { id: 'human',   label: 'Human',   labelKo: '사람' },
      { id: 'vehicle', label: 'Vehicle', labelKo: '차량' },
    ],
  },
  {
    groupKey: 'zoneGroupAccessories',
    items: [
      // Phase-1: COCO yolov8n — no extra model required
      { id: 'backpack',      label: 'Backpack',        labelKo: '배낭'        },
      { id: 'handbag',       label: 'Handbag',         labelKo: '핸드백'      },
      { id: 'suitcase',      label: 'Suitcase',        labelKo: '여행가방'    },
      { id: 'umbrella',      label: 'Umbrella',        labelKo: '우산'        },
      { id: 'tie',           label: 'Tie',             labelKo: '넥타이'      },
      // Sports & outdoor equipment (COCO yolov8n)
      { id: 'sportsball',    label: 'Sports Ball',     labelKo: '공'          },
      { id: 'frisbee',       label: 'Frisbee',         labelKo: '프리즈비'    },
      { id: 'skis',          label: 'Skis',            labelKo: '스키'        },
      { id: 'snowboard',     label: 'Snowboard',       labelKo: '스노보드'    },
      { id: 'baseballbat',   label: 'Baseball Bat',    labelKo: '야구 방망이' },
      { id: 'baseballglove', label: 'Baseball Glove',  labelKo: '야구 글러브' },
      { id: 'skateboard',    label: 'Skateboard',      labelKo: '스케이트보드'},
      { id: 'surfboard',     label: 'Surfboard',       labelKo: '서핑보드'    },
      { id: 'tennisracket',  label: 'Tennis Racket',   labelKo: '테니스 라켓' },
      { id: 'kite',          label: 'Kite',            labelKo: '연'          },
      // Personal tools / items (COCO yolov8n)
      { id: 'remote',        label: 'Remote',          labelKo: '리모컨'      },
      { id: 'scissors',      label: 'Scissors',        labelKo: '가위'        },
      { id: 'fork',          label: 'Fork',            labelKo: '포크'        },
      { id: 'knife',         label: 'Knife',           labelKo: '칼'          },
      { id: 'spoon',         label: 'Spoon',           labelKo: '숟가락'      },
      // Phase-2: worn accessories — dedicated classifier model required
      { id: 'glasses',       label: 'Glasses',         labelKo: '안경',       pending: true },
      { id: 'sunglasses',    label: 'Sunglasses',      labelKo: '선글라스',   pending: true },
    ],
  },
  {
    groupKey: 'zoneGroupAiAttributes',
    items: [
      { id: 'face',  label: 'Face Recognition', labelKo: '얼굴 인식', model: 'scrfd_2.5g.onnx + arcface_w600k_r50.onnx' },
      { id: 'mask',  label: 'Mask',  labelKo: '마스크', model: 'yolov8m_ppe.onnx' },
      { id: 'color', label: 'Color', labelKo: '색상'   },
      { id: 'cloth', label: 'Cloth', labelKo: '의류',   model: 'openpar.onnx',
        installHint: 'Generate model: python3 server/src/scripts/exportPAR.py' },
      { id: 'hat',   label: 'Hat',   labelKo: '헬멧/안전모', model: 'yolov8m_ppe.onnx' },
    ],
  },
  {
    groupKey: 'zoneGroupHazards',
    items: [
      { id: 'fire',  label: 'Fire',  labelKo: '화재', model: 'yolov8s_fire_smoke.onnx' },
      { id: 'smoke', label: 'Smoke', labelKo: '연기', model: 'yolov8s_fire_smoke.onnx' },
    ],
  },
  {
    groupKey: 'zoneGroupIndoor',
    items: [
      { id: 'chair',       label: 'Chair',      labelKo: '의자'      },
      { id: 'couch',       label: 'Couch/Sofa', labelKo: '소파'      },
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
  {
    groupKey: 'zoneGroupAnimals',
    items: [
      { id: 'bird',     label: 'Bird',     labelKo: '새'       },
      { id: 'cat',      label: 'Cat',      labelKo: '고양이'   },
      { id: 'dog',      label: 'Dog',      labelKo: '개'       },
      { id: 'horse',    label: 'Horse',    labelKo: '말'       },
      { id: 'sheep',    label: 'Sheep',    labelKo: '양'       },
      { id: 'cow',      label: 'Cow',      labelKo: '소'       },
      { id: 'elephant', label: 'Elephant', labelKo: '코끼리'   },
      { id: 'bear',     label: 'Bear',     labelKo: '곰'       },
      { id: 'zebra',    label: 'Zebra',    labelKo: '얼룩말'   },
      { id: 'giraffe',  label: 'Giraffe',  labelKo: '기린'     },
    ],
  },
  {
    groupKey: 'zoneGroupOutdoor',
    items: [
      { id: 'bench',        label: 'Bench',         labelKo: '벤치'         },
      { id: 'trafficlight', label: 'Traffic Light',  labelKo: '신호등'       },
      { id: 'firehydrant',  label: 'Fire Hydrant',   labelKo: '소화전'       },
      { id: 'stopsign',     label: 'Stop Sign',      labelKo: '정지 표지판'  },
      { id: 'parkingmeter', label: 'Parking Meter',  labelKo: '주차 미터기'  },
      { id: 'airplane',     label: 'Airplane',       labelKo: '비행기'       },
      { id: 'boat',         label: 'Boat',           labelKo: '보트'         },
      { id: 'train',        label: 'Train',          labelKo: '기차'         },
    ],
  },
  {
    groupKey: 'zoneGroupFood',
    items: [
      { id: 'bowl',      label: 'Bowl',       labelKo: '그릇'    },
      { id: 'wineglass', label: 'Wine Glass', labelKo: '와인잔'  },
      { id: 'banana',    label: 'Banana',     labelKo: '바나나'  },
      { id: 'apple',     label: 'Apple',      labelKo: '사과'    },
      { id: 'sandwich',  label: 'Sandwich',   labelKo: '샌드위치'},
      { id: 'orange',    label: 'Orange',     labelKo: '오렌지'  },
      { id: 'broccoli',  label: 'Broccoli',   labelKo: '브로콜리'},
      { id: 'carrot',    label: 'Carrot',     labelKo: '당근'    },
      { id: 'hotdog',    label: 'Hot Dog',    labelKo: '핫도그'  },
      { id: 'pizza',     label: 'Pizza',      labelKo: '피자'    },
      { id: 'donut',     label: 'Donut',      labelKo: '도넛'    },
      { id: 'cake',      label: 'Cake',       labelKo: '케이크'  },
    ],
  },
  {
    groupKey: 'zoneGroupHomeAppliances',
    items: [
      { id: 'bed',          label: 'Bed',           labelKo: '침대'      },
      { id: 'toilet',       label: 'Toilet',        labelKo: '변기'      },
      { id: 'sink',         label: 'Sink',          labelKo: '세면대'    },
      { id: 'microwave',    label: 'Microwave',     labelKo: '전자레인지'},
      { id: 'oven',         label: 'Oven',          labelKo: '오븐'      },
      { id: 'toaster',      label: 'Toaster',       labelKo: '토스터'    },
      { id: 'refrigerator', label: 'Refrigerator',  labelKo: '냉장고'    },
      { id: 'pottedplant',  label: 'Potted Plant',  labelKo: '화분'      },
      { id: 'teddybear',    label: 'Teddy Bear',    labelKo: '곰인형'    },
      { id: 'hairdrier',    label: 'Hair Drier',    labelKo: '헤어드라이어'},
      { id: 'toothbrush',   label: 'Toothbrush',    labelKo: '칫솔'      },
    ],
  },
];

export default function VideoAnalyticsTab() {
  const { t, lang } = useI18n();

  // enabled: current module on/off state
  const [enabled, setEnabled]   = useState<Record<string, boolean>>({});
  // caps: which modules are available (boolean, backward-compat)
  const [caps, setCaps]         = useState<Record<string, boolean>>({});
  // capStatus: detailed status per module ('builtin'|'available'|'loaded'|'failed'|'missing'|'pending')
  const [capStatus, setCapStatus] = useState<Record<string, string>>({});
  const [saving, setSaving]     = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Kalman / Tracker settings
  const [kalman, setKalman]             = useState<KalmanConfig>({ ...KALMAN_DEFAULTS });
  const [kalmanOpen, setKalmanOpen]     = useState(false);
  const [kalmanSaving, setKalmanSaving] = useState(false);
  const [appearOpen, setAppearOpen]     = useState(false);
  const kalmanDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fire / Smoke sensitivity
  const [fireSmokeConfig, setFireSmokeConfig] = useState<FireSmokeConfig>({ ...FIRE_SMOKE_DEFAULTS });
  const [fireSmokeOpen, setFireSmokeOpen]     = useState(false);
  const [fireSmokeSaving, setFireSmokeSaving] = useState(false);
  const [fireSmokeAvailable, setFireSmokeAvailable] = useState(false);
  const fireSmokeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/analytics/config').then(r => r.json()),
      fetch('/api/capabilities').then(r => r.json()),
      fetch('/api/tracker/config').then(r => r.json()),
      fetch('/api/analysis/config/fire-smoke').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([cfg, cap, kfg, fsCfg]) => {
        if (cfg.success) setEnabled(cfg.data);
        if (cap.ai)      setCaps(cap.ai);
        if (cap.status)  setCapStatus(cap.status);
        if (kfg.success) setKalman(prev => ({ ...prev, ...kfg.data }));
        if (fsCfg) {
          setFireSmokeAvailable(fsCfg.available !== false);
          setFireSmokeConfig({
            confThreshold: fsCfg.confThreshold ?? FIRE_SMOKE_DEFAULTS.confThreshold,
            nmsThreshold:  fsCfg.nmsThreshold  ?? FIRE_SMOKE_DEFAULTS.nmsThreshold,
          });
        }
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
      setEnabled(prev => ({ ...prev, [id]: !next }));
    } finally {
      setSaving(null);
    }
  };

  const _availableIdsForGroup = (group: AttrGroup) =>
    group.items
      .filter(item => {
        const st = capStatus[item.id] ?? (item.pending ? 'pending' : '');
        return caps[item.id] !== false && st !== 'pending' && st !== 'failed' && st !== 'missing';
      })
      .map(item => item.id);

  const toggleAll = async (on: boolean) => {
    const availableIds = GROUPS.flatMap(g => _availableIdsForGroup(g));
    const patch = Object.fromEntries(availableIds.map(id => [id, on]));
    setEnabled(prev => ({ ...prev, ...patch }));
    setSaving('__all__');
    try {
      await fetch('/api/analytics/config', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      });
    } catch {
      setEnabled(prev => ({ ...prev, ...Object.fromEntries(availableIds.map(id => [id, !on])) }));
    } finally {
      setSaving(null);
    }
  };

  const toggleGroup = async (group: AttrGroup) => {
    const availableIds = _availableIdsForGroup(group);
    if (availableIds.length === 0) return;
    // If all available items in the group are on → turn off; otherwise turn all on
    const allOn = availableIds.every(id => enabled[id] === true);
    const next  = !allOn;
    const patch = Object.fromEntries(availableIds.map(id => [id, next]));
    setEnabled(prev => ({ ...prev, ...patch }));
    setSaving(`__group__${group.groupKey}`);
    try {
      await fetch('/api/analytics/config', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      });
    } catch {
      setEnabled(prev => ({ ...prev, ...Object.fromEntries(availableIds.map(id => [id, !next])) }));
    } finally {
      setSaving(null);
    }
  };

  const handleKalmanChange = (key: keyof KalmanConfig, value: number) => {
    const next = { ...kalman, [key]: value };
    setKalman(next);
    if (kalmanDebounce.current) clearTimeout(kalmanDebounce.current);
    kalmanDebounce.current = setTimeout(async () => {
      setKalmanSaving(true);
      try {
        await fetch('/api/tracker/config', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ [key]: value }),
        });
      } finally {
        setKalmanSaving(false);
      }
    }, 300);
  };

  const resetKalman = async () => {
    setKalmanSaving(true);
    try {
      const res = await fetch('/api/tracker/config/reset', { method: 'POST' });
      const { data } = await res.json();
      setKalman(data);
    } finally {
      setKalmanSaving(false);
    }
  };

  const handleFireSmokeChange = (key: keyof FireSmokeConfig, value: number) => {
    const next = { ...fireSmokeConfig, [key]: value };
    setFireSmokeConfig(next);
    if (fireSmokeDebounce.current) clearTimeout(fireSmokeDebounce.current);
    fireSmokeDebounce.current = setTimeout(async () => {
      setFireSmokeSaving(true);
      try {
        await fetch('/api/analysis/config/fire-smoke', {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ [key]: value }),
        });
      } finally {
        setFireSmokeSaving(false);
      }
    }, 300);
  };

  const resetFireSmoke = async () => {
    setFireSmokeSaving(true);
    try {
      await fetch('/api/analysis/config/fire-smoke', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(FIRE_SMOKE_DEFAULTS),
      });
      setFireSmokeConfig({ ...FIRE_SMOKE_DEFAULTS });
    } finally {
      setFireSmokeSaving(false);
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

  const isSavingAll  = saving === '__all__';
  const allAvailable = GROUPS.flatMap(g => _availableIdsForGroup(g));
  const globalAllOn  = allAvailable.some(id => enabled[id] === true);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold text-white uppercase tracking-wide">{t.tabVideoAnalytics}</h2>
          <button
            onClick={() => toggleAll(!globalAllOn)}
            disabled={isSavingAll}
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] text-left transition-colors border disabled:opacity-40 ${
              globalAllOn
                ? 'bg-blue-700/70 border-blue-500 text-white hover:bg-blue-700'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
            }`}
            title={globalAllOn ? '모든 모듈 비활성화' : '사용 가능한 모든 모듈 활성화'}
          >
            <span className={`w-7 h-3.5 rounded-full flex-shrink-0 relative transition-colors ${globalAllOn ? 'bg-blue-500' : 'bg-gray-600'}`}>
              <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-all ${globalAllOn ? 'left-3.5' : 'left-0.5'}`} />
            </span>
            {isSavingAll ? '…' : 'All'}
          </button>
        </div>
        <p className="text-[10px] text-gray-500 mt-0.5">{t.videoAnalyticsHint}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">

        {GROUPS.map((group) => {
          const groupAvailableIds = _availableIdsForGroup(group);
          const groupAllOn        = groupAvailableIds.some(id => enabled[id] === true);
          const isSavingGroup     = saving === `__group__${group.groupKey}`;
          return (
          <div key={group.groupKey}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[9px] text-gray-500 uppercase tracking-wide font-bold">
                {groupLabel(group.groupKey)}
              </span>
              {groupAvailableIds.length > 0 && (
                <button
                  onClick={() => toggleGroup(group)}
                  disabled={isSavingGroup || saving === '__all__'}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] transition-colors border disabled:opacity-40 ${
                    groupAllOn
                      ? 'bg-blue-700/70 border-blue-500 text-white hover:bg-blue-700'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
                  }`}
                  title={groupAllOn ? '그룹 전체 비활성화' : '그룹 전체 활성화'}
                >
                  <span className={`w-5 h-2.5 rounded-full flex-shrink-0 relative transition-colors ${groupAllOn ? 'bg-blue-500' : 'bg-gray-600'}`}>
                    <span className={`absolute top-0.5 w-1.5 h-1.5 rounded-full bg-white shadow transition-all ${groupAllOn ? 'left-2.5' : 'left-0.5'}`} />
                  </span>
                  {isSavingGroup ? '…' : (groupAllOn ? 'On' : 'Off')}
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {group.items.map((item) => {
                const available  = caps[item.id] !== false;
                const isEnabled  = enabled[item.id] === true;
                const isSaving   = saving === item.id;
                const st         = capStatus[item.id] ?? (item.pending ? 'pending' : '');
                const isFailed   = st === 'failed';

                const statusTag =
                  st === 'pending'   ? 'Phase-2'      :
                  st === 'missing'   ? 'Not Installed' :
                  st === 'failed'    ? 'Load Failed'   :
                  st === 'loaded'    ? 'Active'        :
                  st === 'available' ? 'Standby'       : '';

                const tooltipText = !available
                  ? st === 'pending'
                    ? 'Planned feature (Phase-2)'
                    : st === 'failed'
                    ? `Model load failed — file may be corrupt or out of memory\nPath: server/models/${item.model ?? ''}`
                    : item.installHint
                    ? `Model file required: ${item.model}\n${item.installHint}`
                    : item.model
                    ? `Model file required: ${item.model}\nInstall: cd server && npm run download-models`
                    : 'Model not installed'
                  : isEnabled
                  ? 'Click to disable'
                  : 'Click to enable';

                return (
                  <button
                    key={item.id}
                    onClick={() => available && toggle(item.id)}
                    disabled={!available || isSaving}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] text-left transition-colors border ${
                      !available
                        ? isFailed
                          ? 'opacity-50 cursor-not-allowed bg-gray-800 border-red-900/50 text-gray-500'
                          : st === 'pending'
                          ? 'opacity-35 cursor-not-allowed bg-gray-800 border-transparent text-gray-500'
                          : 'opacity-60 cursor-not-allowed bg-gray-800 border-dashed border-gray-600 text-gray-500'
                        : isEnabled
                        ? 'bg-blue-700/70 border-blue-500 text-white'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
                    }`}
                    title={tooltipText}
                  >
                    {/* Toggle indicator */}
                    <span className={`w-7 h-3.5 rounded-full flex-shrink-0 relative transition-colors ${
                      !available ? (isFailed ? 'bg-red-900/60' : 'bg-gray-700') : isEnabled ? 'bg-blue-500' : 'bg-gray-600'
                    }`}>
                      <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-all ${
                        isEnabled ? 'left-3.5' : 'left-0.5'
                      }`} />
                    </span>
                    <span className="truncate">
                      {lang === 'ko' ? item.labelKo : item.label}
                    </span>
                    {isSaving && <span className="ml-auto text-[8px] text-blue-300 animate-pulse">…</span>}
                    {statusTag && !isSaving && (
                      <span className={`ml-auto text-[8px] shrink-0 ${
                        st === 'failed'  ? 'text-red-500'   :
                        st === 'loaded'  ? 'text-green-500' :
                        st === 'pending' ? 'text-gray-600'  : 'text-gray-600'
                      }`}>
                        {statusTag}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          );
        })}

        {/* Appearance Weights */}
        <div className="border-t border-gray-700/50 pt-3">
          <button
            onClick={() => setAppearOpen(prev => !prev)}
            className="flex items-center justify-between w-full text-[9px] text-gray-500 uppercase tracking-wide font-bold mb-1.5 hover:text-gray-400"
          >
            <span>◈ Appearance Weights</span>
            <span className="text-[10px]">{appearOpen ? '▲' : '▼'}</span>
          </button>

          {appearOpen && (
            <div className="bg-gray-900/70 rounded-md p-2 space-y-2.5">
              {/* Weight bars — visualise relative contribution */}
              <div className="space-y-1 pb-2 border-b border-gray-700/40">
                {APPEARANCE_SLIDERS.map(s => {
                  const total = APPEARANCE_SLIDERS.reduce((sum, x) => sum + (kalman[x.key] as number), 0);
                  const pct   = total > 0 ? Math.round(((kalman[s.key] as number) / total) * 100) : 0;
                  const barColors: Record<string, string> = {
                    'accent-blue-400':   'bg-blue-500',
                    'accent-green-400':  'bg-green-500',
                    'accent-yellow-400': 'bg-yellow-500',
                    'accent-orange-400': 'bg-orange-500',
                    'accent-purple-400': 'bg-purple-500',
                  };
                  return (
                    <div key={s.key} className="flex items-center gap-1.5">
                      <span className="text-[9px] text-gray-500 w-16 shrink-0">{s.label.split(' ')[0]}</span>
                      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${barColors[s.color] ?? 'bg-gray-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[9px] text-gray-400 font-mono w-7 text-right">{pct}%</span>
                    </div>
                  );
                })}
              </div>

              {APPEARANCE_SLIDERS.map(s => (
                <div key={s.key}>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-gray-400">{s.label}</label>
                    <span className="text-[10px] text-white font-semibold font-mono">
                      {(kalman[s.key] as number).toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={s.min} max={s.max} step={s.step}
                    value={kalman[s.key] as number}
                    onChange={(e) => handleKalmanChange(s.key, Number(e.target.value))}
                    className={`w-full h-1 ${s.color}`}
                  />
                  <p className="text-[9px] text-gray-600 mt-0.5">{s.hint}</p>
                </div>
              ))}

              <div className="flex gap-1 pt-1 border-t border-gray-700/50">
                <button
                  onClick={resetKalman}
                  disabled={kalmanSaving}
                  className="flex-1 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-[10px] text-gray-400"
                >
                  Reset Defaults
                </button>
                {kalmanSaving && (
                  <span className="text-[9px] text-purple-400 animate-pulse self-center">saving…</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Fire / Smoke Sensitivity */}
        {fireSmokeAvailable && (
          <div className="border-t border-gray-700/50 pt-3">
            <button
              onClick={() => setFireSmokeOpen(prev => !prev)}
              className="flex items-center justify-between w-full text-[9px] text-gray-500 uppercase tracking-wide font-bold mb-1.5 hover:text-gray-400"
            >
              <span>🔥 Fire / Smoke Sensitivity</span>
              <span className="text-[10px]">{fireSmokeOpen ? '▲' : '▼'}</span>
            </button>

            {fireSmokeOpen && (
              <div className="bg-gray-900/70 rounded-md p-2 space-y-2.5">
                {/* Conf Threshold */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-gray-400">Conf Threshold</label>
                    <span className="text-[10px] text-white font-semibold font-mono">
                      {fireSmokeConfig.confThreshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.05} max={0.95} step={0.05}
                    value={fireSmokeConfig.confThreshold}
                    onChange={(e) => handleFireSmokeChange('confThreshold', Number(e.target.value))}
                    className="w-full accent-orange-500 h-1"
                  />
                  <p className="text-[9px] text-gray-600 mt-0.5">
                    낮을수록 감도 ↑ (false positive 증가). 기본값: 0.35
                  </p>
                </div>

                {/* NMS IoU Threshold */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-gray-400">NMS IoU Threshold</label>
                    <span className="text-[10px] text-white font-semibold font-mono">
                      {fireSmokeConfig.nmsThreshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.10} max={0.90} step={0.05}
                    value={fireSmokeConfig.nmsThreshold}
                    onChange={(e) => handleFireSmokeChange('nmsThreshold', Number(e.target.value))}
                    className="w-full accent-orange-500 h-1"
                  />
                  <p className="text-[9px] text-gray-600 mt-0.5">
                    낮을수록 겹치는 박스 더 적게 유지. 기본값: 0.45
                  </p>
                </div>

                <div className="flex gap-1 pt-1 border-t border-gray-700/50">
                  <button
                    onClick={resetFireSmoke}
                    disabled={fireSmokeSaving}
                    className="flex-1 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-[10px] text-gray-400"
                  >
                    Reset Defaults
                  </button>
                  {fireSmokeSaving && (
                    <span className="text-[9px] text-orange-400 animate-pulse self-center">saving…</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Kalman / Tracker Settings */}
        <div className="border-t border-gray-700/50 pt-3">
          <button
            onClick={() => setKalmanOpen(prev => !prev)}
            className="flex items-center justify-between w-full text-[9px] text-gray-500 uppercase tracking-wide font-bold mb-1.5 hover:text-gray-400"
          >
            <span>⚙ Tracker / Kalman Settings</span>
            <span className="text-[10px]">{kalmanOpen ? '▲' : '▼'}</span>
          </button>

          {kalmanOpen && (
            <div className="bg-gray-900/70 rounded-md p-2 space-y-2.5">
              {KALMAN_SLIDERS.map(s => (
                <div key={s.key}>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-gray-400">{s.label}</label>
                    <span className="text-[10px] text-white font-semibold font-mono">
                      {typeof kalman[s.key] === 'number'
                        ? s.step < 1 ? (kalman[s.key] as number).toFixed(2) : kalman[s.key]
                        : kalman[s.key]
                      }{s.unit}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={s.min} max={s.max} step={s.step}
                    value={kalman[s.key] as number}
                    onChange={(e) => handleKalmanChange(s.key, Number(e.target.value))}
                    className="w-full accent-purple-500 h-1"
                  />
                  <p className="text-[9px] text-gray-600 mt-0.5">{s.hint}</p>
                </div>
              ))}

              <div className="flex gap-1 pt-1 border-t border-gray-700/50">
                <button
                  onClick={resetKalman}
                  disabled={kalmanSaving}
                  className="flex-1 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-[10px] text-gray-400"
                >
                  Reset Defaults
                </button>
                {kalmanSaving && (
                  <span className="text-[9px] text-purple-400 animate-pulse self-center">saving…</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer hint */}
      <div className="px-3 py-2 border-t border-gray-700 flex-shrink-0 space-y-1">
        <p className="text-[9px] text-gray-600 leading-relaxed">{t.videoAnalyticsFooter}</p>
        {GROUPS.flatMap(g => g.items).some(i => capStatus[i.id] === 'missing') && (
          <p className="text-[9px] text-yellow-700 leading-relaxed">
            Missing modules: <code className="text-yellow-600">cd server && npm run download-models</code>
          </p>
        )}
        {GROUPS.flatMap(g => g.items).some(i => capStatus[i.id] === 'failed') && (
          <p className="text-[9px] text-red-700 leading-relaxed">
            Some modules failed to load. Check for insufficient memory or corrupt model files.
          </p>
        )}
      </div>
    </div>
  );
}
