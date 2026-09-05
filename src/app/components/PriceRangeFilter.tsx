'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TRACK_SIZE,
  clampPrice,
  formatScaleValue,
  getPriceScale,
  parsePriceInput,
  posToSnappedValue,
  snapDown,
  snapUp,
  valueToPos,
  type PricePurpose,
} from '@/lib/priceScale';

export interface PriceRangeValue {
  min?: number;
  max?: number;
}

interface PriceRangeFilterProps {
  currency?: string;
  purpose?: PricePurpose;
  value: PriceRangeValue;
  onChange: (v: PriceRangeValue) => void;
  /** Fired on drag-end / input commit so parents can fetch immediately. Defaults to onChange. */
  onCommit?: (v: PriceRangeValue) => void;
  id?: string;
}

function normOpenEnds(
  v: PriceRangeValue,
  min: number,
  max: number
): PriceRangeValue {
  const out: PriceRangeValue = {};
  if (v.min != null && Number.isFinite(v.min) && v.min > min) out.min = Math.round(v.min);
  if (v.max != null && Number.isFinite(v.max) && v.max < max) out.max = Math.round(v.max);
  return out;
}

export default function PriceRangeFilter({
  currency,
  purpose = 'sale',
  value,
  onChange,
  onCommit,
  id = 'price',
}: PriceRangeFilterProps) {
  const scale = useMemo(() => getPriceScale(currency, purpose), [currency, purpose]);
  const commit = onCommit ?? onChange;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragThumb = useRef<'min' | 'max' | null>(null);
  const [focused, setFocused] = useState<'min' | 'max' | null>(null);
  const [minText, setMinText] = useState(value.min != null ? String(value.min) : '');
  const [maxText, setMaxText] = useState(value.max != null ? String(value.max) : '');
  const [error, setError] = useState<string | null>(null);

  // Keep text fields in sync with external value while not editing.
  useEffect(() => {
    if (focused !== 'min') setMinText(value.min != null ? String(value.min) : '');
  }, [value.min, focused]);
  useEffect(() => {
    if (focused !== 'max') setMaxText(value.max != null ? String(value.max) : '');
  }, [value.max, focused]);

  const minPos = value.min != null ? valueToPos(scale, value.min) : 0;
  const maxPos = value.max != null ? valueToPos(scale, value.max) : TRACK_SIZE;

  const commitValue = useCallback(
    (v: PriceRangeValue) => {
      const n = normOpenEnds(v, scale.min, scale.max);
      onChange(n);
      commit(n);
    },
    [commit, onChange, scale.min, scale.max]
  );

  const liveValue = useCallback(
    (v: PriceRangeValue) => {
      onChange(normOpenEnds(v, scale.min, scale.max));
    },
    [onChange, scale.min, scale.max]
  );

  const posFromClientX = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const frac = (clientX - rect.left) / rect.width;
    return Math.min(TRACK_SIZE, Math.max(0, Math.round(frac * TRACK_SIZE)));
  }, []);

  const applyPos = useCallback(
    (thumb: 'min' | 'max', pos: number, finalize: boolean) => {
      if (thumb === 'min') {
        const clamped = Math.min(pos, maxPos);
        const snapped = snapDown(scale, clampPrice(scale, posToSnappedValue(scale, clamped, 'down')));
        const next: PriceRangeValue = { ...value, min: snapped <= scale.min ? undefined : snapped };
        // Never cross max.
        if (next.min != null && value.max != null && next.min > value.max) next.min = value.max;
        if (finalize) commitValue(next);
        else liveValue(next);
      } else {
        const clamped = Math.max(pos, minPos);
        const snapped = snapUp(scale, clampPrice(scale, posToSnappedValue(scale, clamped, 'up')));
        const next: PriceRangeValue = { ...value, max: snapped >= scale.max ? undefined : snapped };
        if (next.max != null && value.min != null && next.max < value.min) next.max = value.min;
        if (finalize) commitValue(next);
        else liveValue(next);
      }
    },
    [commitValue, liveValue, maxPos, minPos, scale, value]
  );

  const onTrackPointerDown = (e: React.PointerEvent) => {
    const pos = posFromClientX(e.clientX);
    // Move the nearer thumb (ties go to min for discoverability).
    const thumb = Math.abs(pos - minPos) <= Math.abs(pos - maxPos) ? 'min' : 'max';
    dragThumb.current = thumb;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    applyPos(thumb, pos, false);
  };

  const onTrackPointerMove = (e: React.PointerEvent) => {
    if (!dragThumb.current) return;
    applyPos(dragThumb.current, posFromClientX(e.clientX), false);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragThumb.current) return;
    applyPos(dragThumb.current, posFromClientX(e.clientX), true);
    dragThumb.current = null;
  };

  const nudge = (thumb: 'min' | 'max', dir: 1 | -1) => {
    const cur = thumb === 'min' ? (value.min ?? scale.min) : (value.max ?? scale.max);
    const step = stepForValue(scale, clampPrice(scale, cur));
    const next = clampPrice(scale, cur + dir * step);
    if (thumb === 'min') {
      const snapped = snapDown(scale, next);
      const v: PriceRangeValue = { ...value, min: snapped <= scale.min ? undefined : snapped };
      if (v.min != null && value.max != null && v.min > value.max) return;
      commitValue(v);
    } else {
      const snapped = snapUp(scale, next);
      const v: PriceRangeValue = { ...value, max: snapped >= scale.max ? undefined : snapped };
      if (v.max != null && value.min != null && v.max < value.min) return;
      commitValue(v);
    }
  };

  const commitTexts = (which: 'min' | 'max' | 'both') => {
    const pMin = minText.trim() === '' ? undefined : parsePriceInput(minText);
    const pMax = maxText.trim() === '' ? undefined : parsePriceInput(maxText);
    if ((which === 'min' || which === 'both') && minText.trim() !== '' && pMin === undefined) {
      setError('Enter min like 500000, 50L or 1.5Cr');
      return;
    }
    if ((which === 'max' || which === 'both') && maxText.trim() !== '' && pMax === undefined) {
      setError('Enter max like 2000000, 20L or 2Cr');
      return;
    }
    let nMin = pMin == null ? undefined : snapDown(scale, clampPrice(scale, pMin));
    let nMax = pMax == null ? undefined : snapUp(scale, clampPrice(scale, pMax));
    if (nMin != null && nMin <= scale.min) nMin = undefined;
    if (nMax != null && nMax >= scale.max) nMax = undefined;
    if (nMin != null && nMax != null && nMin > nMax) {
      setError('Min can’t be more than max');
      return;
    }
    setError(null);
    commitValue({ min: nMin, max: nMax });
  };

  const clear = () => {
    setError(null);
    setMinText('');
    setMaxText('');
    commitValue({});
  };

  const minLabel = value.min != null ? formatScaleValue(value.min, currency) : 'No min';
  const maxLabel = value.max != null ? formatScaleValue(value.max, currency) : (scale.ceilLabel ?? 'Any');
  const hasValue = value.min != null || value.max != null;

  const pct = (p: number) => `${(p / TRACK_SIZE) * 100}%`;

  return (
    <div className="space-y-2" data-testid={`price-range-${id}`}>
      <div className="flex items-center justify-between">
        <label className="text-sm text-text-color-light" htmlFor={`${id}-min`}>
          Price Range{currency ? ` (${currency})` : ''}
        </label>
        {hasValue && (
          <button
            type="button"
            onClick={clear}
            className="text-xs font-semibold text-blue-600 hover:underline"
            aria-label="Clear price filter"
          >
            Reset
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          id={`${id}-min`}
          inputMode="decimal"
          autoComplete="off"
          placeholder="No min"
          aria-label="Minimum price"
          value={focused === 'min' ? minText : value.min != null ? String(value.min) : minText}
          onChange={(e) => {
            setMinText(e.target.value);
            if (error) setError(null);
          }}
          onFocus={() => setFocused('min')}
          onBlur={() => {
            setFocused(null);
            if (minText !== (value.min != null ? String(value.min) : '')) commitTexts('both');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="neumorphic-input w-full"
        />
        <input
          id={`${id}-max`}
          inputMode="decimal"
          autoComplete="off"
          placeholder={scale.ceilLabel ?? 'No max'}
          aria-label="Maximum price"
          value={focused === 'max' ? maxText : value.max != null ? String(value.max) : maxText}
          onChange={(e) => {
            setMaxText(e.target.value);
            if (error) setError(null);
          }}
          onFocus={() => setFocused('max')}
          onBlur={() => {
            setFocused(null);
            if (maxText !== (value.max != null ? String(value.max) : '')) commitTexts('both');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="neumorphic-input w-full"
        />
      </div>

      <div className="px-1 pt-1">
        {/* Dual-thumb slider: equal-weight-per-tier track, so boundary crossings never jump. */}
        <div
          ref={trackRef}
          role="group"
          aria-label="Price range slider"
          className="relative h-6 cursor-pointer touch-none select-none"
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={() => {
            dragThumb.current = null;
          }}
        >
          <div className="absolute top-1/2 h-2 w-full -translate-y-1/2 rounded-full shadow-neumorphic-inset bg-shadow-dark/10" />
          <div
            className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-cta-gradient"
            style={{ left: pct(minPos), width: `calc(${pct(maxPos - minPos)} - 0px)` }}
          />
          <div
            role="slider"
            tabIndex={0}
            aria-label="Minimum price"
            aria-valuemin={scale.min}
            aria-valuemax={value.max ?? scale.max}
            aria-valuenow={value.min ?? scale.min}
            aria-valuetext={minLabel}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault();
                nudge('min', -1);
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault();
                nudge('min', 1);
              } else if (e.key === 'Home') {
                e.preventDefault();
                commitValue({ ...value, min: undefined });
              }
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              dragThumb.current = 'min';
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (dragThumb.current === 'min') {
                e.stopPropagation();
                applyPos('min', posFromClientX(e.clientX), false);
              }
            }}
            onPointerUp={(e) => {
              if (dragThumb.current === 'min') {
                e.stopPropagation();
                applyPos('min', posFromClientX(e.clientX), true);
                dragThumb.current = null;
              }
            }}
            className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bg-color shadow-neumorphic-outset border border-shadow-dark/20 focus:outline-none focus:ring-2 focus:ring-blue-500"
            style={{ left: pct(minPos) }}
          />
          <div
            role="slider"
            tabIndex={0}
            aria-label="Maximum price"
            aria-valuemin={value.min ?? scale.min}
            aria-valuemax={scale.max}
            aria-valuenow={value.max ?? scale.max}
            aria-valuetext={maxLabel}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault();
                nudge('max', -1);
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault();
                nudge('max', 1);
              } else if (e.key === 'End') {
                e.preventDefault();
                commitValue({ ...value, max: undefined });
              }
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              dragThumb.current = 'max';
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (dragThumb.current === 'max') {
                e.stopPropagation();
                applyPos('max', posFromClientX(e.clientX), false);
              }
            }}
            onPointerUp={(e) => {
              if (dragThumb.current === 'max') {
                e.stopPropagation();
                applyPos('max', posFromClientX(e.clientX), true);
                dragThumb.current = null;
              }
            }}
            className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bg-color shadow-neumorphic-outset border border-shadow-dark/20 focus:outline-none focus:ring-2 focus:ring-blue-500"
            style={{ left: pct(maxPos) }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-text-color-light" aria-live="polite">
          <span>
            {minLabel} <span className="mx-1">–</span> {maxLabel}
          </span>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger-color">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
