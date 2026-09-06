import { tenant, PriceScale, PricePurpose } from './tenant';
import { formatMoneyCompact } from './format';

// Headless Zillow-style adaptive price scale. No DOM, no slider dependency —
// the UI (custom dual-thumb or a future noUiSlider adapter) maps pointer
// position <-> value through valueToPos / posToValue, and snaps through
// snapDown / snapUp. All bands come from tenants/*.json priceScales.

export type { PriceScale, PricePurpose };

const GENERIC_FALLBACK_STEP = 50000;

function genericFallback(max = 20000000): PriceScale {
  const step = Math.max(1000, Math.round(max / 400));
  return { min: 0, max, tiers: [{ upTo: max, step }] };
}

function legacyFallback(currency: string): PriceScale {
  const step = tenant.filterNormalization.priceSteps[currency] ?? GENERIC_FALLBACK_STEP;
  const max = Math.max(step * 400, step);
  return { min: 0, max, tiers: [{ upTo: max, step }] };
}

/** Resolve the configured scale. Unknown currency/purpose falls back safely (never throws). */
export function getPriceScale(currency?: string, purpose?: PricePurpose): PriceScale {
  const code = currency || tenant.propertyCurrency;
  const p: PricePurpose = purpose === 'rent' ? 'rent' : 'sale';
  const scales = tenant.priceScales;
  const entry = scales?.[code];
  if (entry?.[p]) return entry[p];
  if (entry?.sale) return entry.sale;
  return legacyFallback(code);
}

/** 'rent'/'sale' from a listing-purpose label or id-ish string. Defaults to sale. */
export function purposeFromListingPurpose(listingPurpose?: string | null): PricePurpose {
  if (typeof listingPurpose === 'string' && /rent|lease|\bpg\b/i.test(listingPurpose)) return 'rent';
  return 'sale';
}

export function cleanFloat(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Tier index containing value (first tier with upTo >= value; clamps to ends). */
export function tierIndexForValue(scale: PriceScale, value: number): number {
  for (let i = 0; i < scale.tiers.length; i++) {
    if (value <= scale.tiers[i].upTo) return i;
  }
  return scale.tiers.length - 1;
}

/** Increment applying at a value (the tier's step). */
export function stepForValue(scale: PriceScale, value: number): number {
  return scale.tiers[tierIndexForValue(scale, value)].step;
}

/** Finest step across the scale — used for cache-bucket widening across scopes. */
export function finestStep(scale: PriceScale): number {
  return scale.tiers.reduce((m, t) => Math.min(m, t.step), Infinity);
}

export function clampPrice(scale: PriceScale, value: number): number {
  if (!Number.isFinite(value)) return scale.min;
  return Math.min(scale.max, Math.max(scale.min, value));
}

/** Floor to the active tier's step (widen for min). Tier-relative so 1Cr+ bands snap to 10L, not 5L. */
export function snapDown(scale: PriceScale, value: number): number {
  const c = clampPrice(scale, value);
  const idx = tierIndexForValue(scale, c);
  const lo = idx === 0 ? scale.min : scale.tiers[idx - 1].upTo;
  const step = scale.tiers[idx].step;
  const snapped = lo + Math.floor((c - lo) / step) * step;
  return cleanFloat(Math.max(scale.min, snapped));
}

/** Ceil to the active tier's step (widen for max). */
export function snapUp(scale: PriceScale, value: number): number {
  const c = clampPrice(scale, value);
  const idx = tierIndexForValue(scale, c);
  const lo = idx === 0 ? scale.min : scale.tiers[idx - 1].upTo;
  const step = scale.tiers[idx].step;
  const snapped = lo + Math.ceil((c - lo) / step) * step;
  return cleanFloat(Math.min(scale.max, snapped));
}

// --- Non-linear track mapping (the smooth-transition core) ---
//
// Each tier owns an EQUAL share of the track (1/nTiers), regardless of its
// rupee span. So <1Cr (5L steps) gets the same drag distance as 10-20Cr
// (50L steps): low ranges feel precise, high ranges don't eat the track,
// and crossing a boundary never jumps — only the value-delta per pixel
// changes. Position domain is 0..1000 (int-friendly for range inputs).

export const TRACK_SIZE = 1000;

function tierBounds(scale: PriceScale, idx: number): { lo: number; hi: number } {
  const lo = idx === 0 ? scale.min : scale.tiers[idx - 1].upTo;
  return { lo, hi: scale.tiers[idx].upTo };
}

export function valueToPos(scale: PriceScale, value: number): number {
  const n = scale.tiers.length;
  const c = clampPrice(scale, value);
  const idx = tierIndexForValue(scale, c);
  const { lo, hi } = tierBounds(scale, idx);
  const frac = hi <= lo ? 0 : (c - lo) / (hi - lo);
  return cleanFloat(((idx + Math.min(1, Math.max(0, frac))) / n) * TRACK_SIZE);
}

export function posToValue(scale: PriceScale, pos: number): number {
  const n = scale.tiers.length;
  const p = Math.min(TRACK_SIZE, Math.max(0, pos)) / TRACK_SIZE;
  const exact = p * n;
  const idx = Math.min(n - 1, Math.floor(exact));
  const frac = exact - idx;
  const { lo, hi } = tierBounds(scale, idx);
  return cleanFloat(lo + frac * (hi - lo));
}

/** Drag position -> tier-snapped value. Direction picks floor/ceil to avoid thumb jitter at boundaries. */
export function posToSnappedValue(
  scale: PriceScale,
  pos: number,
  direction: 'down' | 'up' = 'down'
): number {
  const v = posToValue(scale, pos);
  return direction === 'up' ? snapUp(scale, v) : snapDown(scale, v);
}

/** Discrete stops for optional tick marks / datalist (tier boundaries + snapped mids). */
export function scaleTicks(scale: PriceScale): number[] {
  const pts = new Set<number>([scale.min, scale.max]);
  for (const t of scale.tiers) pts.add(t.upTo);
  return Array.from(pts).sort((a, b) => a - b);
}

// --- noUiSlider interop (kept for the evaluated alternative) ---
//
// Equal-weight mapping expressed as noUiSlider's non-linear `range`:
// { '0%': [min, step0], '25%': [t0, step1], ..., '100%': [max] }.
// Lets a future noUi adapter reuse this exact config with native
// per-segment steps and smooth boundary transitions.

export function buildNoUiRange(scale: PriceScale): Record<string, [number, number] | [number]> {
  const n = scale.tiers.length;
  const range: Record<string, [number, number] | [number]> = {};
  range['0%'] = [scale.min, scale.tiers[0].step];
  for (let i = 0; i < n; i++) {
    const pct = ((i + 1) / n) * 100;
    const key = `${Number(pct.toFixed(4))}%`;
    if (i === n - 1) range[key] = [scale.tiers[i].upTo];
    else range[key] = [scale.tiers[i].upTo, scale.tiers[i + 1].step];
  }
  return range;
}

// --- Input parsing / display ---

const SUFFIX_MULT: Array<[RegExp, number]> = [
  [/^(cr|crore)s?$/i, 10000000],
  [/^(l|lakh|lac)s?$/i, 100000],
  [/^k$/i, 1000],
  [/^m$/i, 1000000],
  [/^b$/i, 1000000000],
];

/**
 * Parse free-typed price: "1.5cr", "50L", "25k", "₹ 1,00,000", "500000".
 * Returns undefined for empty/invalid. Never throws.
 */
export function parsePriceInput(raw: string | null | undefined): number | undefined {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (!s) return undefined;
  // Strip currency symbols/codes and whitespace grouping.
  s = s.replace(/[₹$]|AED|INR|USD|Rs\.?/gi, '').trim().replace(/[\s,]/g, '');
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)([a-zA-Z]*)$/);
  if (!m) return undefined;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num < 0) return undefined;
  const suffix = m[2];
  if (!suffix) return num;
  for (const [re, mult] of SUFFIX_MULT) {
    if (re.test(suffix)) return num * mult;
  }
  return undefined;
}

/** Short thumb/tooltip label: '' for empty, ceilLabel handled by caller. */
export function formatScaleValue(value: number | null | undefined, currency?: string): string {
  if (value == null || value <= 0) return '';
  return formatMoneyCompact(value, currency);
}

/** Full locale-aware value for input fields on blur (en-IN grouping). */
export function formatFullPrice(value: number | null | undefined, locale?: string): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '';
  try {
    return new Intl.NumberFormat(locale || tenant.locale, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(Math.round(value));
  }
}

export { genericFallback };
