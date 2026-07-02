import { useEffect, useState } from 'react';

/**
 * Dual channel-slot selector — a numeric stepper AND a grid-size-paged group
 * browser, always shown together and always in sync (FR-CH-030/031).
 * Used by CameraList.tsx (Add modal) and CameraEditModal.tsx (Edit modal).
 * See docs/design/Design_Channel_Slot.md §5.2.
 */

interface ChannelSlotPickerProps {
  value:          number | null;
  onChange:       (slot: number) => void;
  maxChannelNum:  number;
  /** channelSlot → occupying camera name. Exclude the camera being edited. */
  takenSlots:     Map<number, string>;
  /** Page size for the group browser — defaults to the active dashboard layout's channel count. */
  pageSize?:      number;
}

export function ChannelSlotPicker({ value, onChange, maxChannelNum, takenSlots, pageSize = 16 }: ChannelSlotPickerProps) {
  const clampedPageSize = Math.max(1, Math.min(pageSize, maxChannelNum));
  const totalPages = Math.max(1, Math.ceil(maxChannelNum / clampedPageSize));

  const [page, setPage] = useState(() =>
    Math.min(totalPages - 1, Math.floor(((value ?? 1) - 1) / clampedPageSize))
  );

  // Keep the visible page in sync if the selected value jumps outside it
  // (e.g. stepper nudged past the current page boundary).
  useEffect(() => {
    if (value == null) return;
    const containingPage = Math.floor((value - 1) / clampedPageSize);
    if (containingPage !== page) setPage(Math.max(0, Math.min(totalPages - 1, containingPage)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const pageStart = page * clampedPageSize + 1;
  const pageEnd   = Math.min(pageStart + clampedPageSize - 1, maxChannelNum);

  const step = (delta: number) => {
    const next = Math.max(1, Math.min(maxChannelNum, (value ?? 1) + delta));
    onChange(next);
  };

  const handleDirectEntry = (raw: string) => {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= maxChannelNum) onChange(n);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Stepper */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={(value ?? 1) <= 1}
          className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center"
        >
          −
        </button>
        <input
          type="number"
          min={1}
          max={maxChannelNum}
          value={value ?? ''}
          onChange={(e) => handleDirectEntry(e.target.value)}
          className="w-20 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-white text-center focus:outline-none focus:border-blue-500"
        />
        <button
          type="button"
          onClick={() => step(1)}
          disabled={(value ?? 1) >= maxChannelNum}
          className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center"
        >
          +
        </button>
        <span className="text-[10px] text-gray-500">/ {maxChannelNum}</span>
      </div>

      {/* Group browser */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page <= 0}
            className="px-1.5 py-0.5 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed text-xs"
          >
            ◀
          </button>
          <span className="text-[10px] text-gray-400">
            Group {page + 1} of {totalPages} (CH {pageStart}–{pageEnd})
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-1.5 py-0.5 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed text-xs"
          >
            ▶
          </button>
        </div>
        <div className="grid grid-cols-8 gap-1">
          {Array.from({ length: pageEnd - pageStart + 1 }, (_, i) => pageStart + i).map((slot) => {
            const occupant = takenSlots.get(slot);
            const isTaken    = !!occupant;
            const isSelected = value === slot;
            return (
              <button
                key={slot}
                type="button"
                disabled={isTaken}
                onClick={() => onChange(slot)}
                title={isTaken ? occupant : `Channel ${slot}`}
                className={`px-1 py-1 rounded text-[10px] font-mono transition-colors ${
                  isSelected
                    ? 'bg-blue-600 text-white'
                    : isTaken
                    ? 'bg-gray-800 text-gray-600 cursor-not-allowed line-through'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
                }`}
              >
                {slot}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
