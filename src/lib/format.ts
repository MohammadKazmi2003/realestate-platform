import { tenant, listingCurrency } from './tenant';

// Single home for all money/area/beds formatting. Every call site that used
// to hardcode ₹/Cr/L, AED…M, 'sqft' or BHK labels goes through here, so a new
// country is a tenants/{slug}.json file — never a code change.

export function formatMoney(amount: number | null | undefined, currency?: string): string {
  if (amount == null || amount <= 0) return 'Price on request';
  const code = currency || tenant.currency;
  try {
    return new Intl.NumberFormat(tenant.locale, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString()}`;
  }
}

function compactFallback(amount: number, currency: string): string {
  try {
    const compact = new Intl.NumberFormat(tenant.locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount);
    return `${currency} ${compact}`;
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

/** Zillow-style short label ($449K / ₹55L / AED 1.2M). No 'Price on request' — returns '' for empty. */
export function formatMoneyCompact(
  amount: number | null | undefined,
  currency?: string,
  opts?: { symbol?: boolean }
): string {
  if (amount == null || amount <= 0) return '';
  const code = currency || tenant.currency;
  const cfg = tenant.moneyCompact[code];
  const withSymbol = opts?.symbol !== false;
  if (!cfg) {
    const s = compactFallback(amount, withSymbol ? code : '');
    return withSymbol ? s : s.replace(/^[A-Z]{3}\s*/, '');
  }
  for (const step of cfg.steps) {
    if (amount >= step.gte) {
      // digits is max decimals: strip trailing zeros so extra precision
      // never pads whole values (1.50Cr → 1.5Cr, 1Cr stays 1Cr).
      const raw = (amount / step.div).toFixed(step.digits);
      const n = raw.includes('.') ? raw.replace(/\.?0+$/, '') : raw;
      return withSymbol ? `${cfg.symbol}${n}${step.suffix}` : `${n}${step.suffix}`;
    }
  }
  const full = amount.toLocaleString(tenant.locale.startsWith('en-IN') ? 'en-IN' : undefined);
  return withSymbol ? `${cfg.symbol}${full}` : full;
}

/** Range label for project cards ("AED 1.88M - 8.72M"). Sub-step values ≥1000 use K shorthand. */
export function formatMoneyRange(
  low: number | null | undefined,
  high: number | null | undefined,
  currency?: string
): string {
  if (!low || low <= 0) return 'Price on request';
  const code = currency || tenant.currency;
  const one = (v: number): string => {
    const c = formatMoneyCompact(v, code);
    if (c) return c;
    const cfg = tenant.moneyCompact[code];
    const symbol = cfg ? cfg.symbol : `${code} `;
    return `${symbol}${Math.round(v / 1000)}K`;
  };
  if (high && high !== low) {
    // Match legacy shape: symbol once ("AED 1.88M - 8.72M").
    const lo = one(low);
    const hi = one(high);
    const cfg = tenant.moneyCompact[code];
    const bareHi = cfg && hi.startsWith(cfg.symbol) ? hi.slice(cfg.symbol.length) : hi;
    return `${lo} - ${bareHi}`;
  }
  return one(low);
}

export function formatArea(value: number | null | undefined, unit?: string | null): string | null {
  if (value == null || value <= 0) return null;
  return `${Math.round(value)} ${unit || tenant.areaUnit}`;
}

/** Bedroom/bhk display. bhk-model tenants show the stored label; bedrooms-model tenants show "N Beds". */
export function formatBeds(bhkLabel?: string | null, bedrooms?: number | null): string | null {
  if (tenant.bedsModel === 'bedrooms') {
    if (bedrooms == null) return bhkLabel || null;
    if (bedrooms === 0) return 'Studio';
    return `${bedrooms} Bed${bedrooms === 1 ? '' : 's'}`;
  }
  return bhkLabel || null;
}

/**
 * Project config summary from indexed bedrooms_list — always explicit, suffix
 * exactly once, e.g. [0,1,2,3] → "Studio, 1, 2 & 3 BHK", [1,2,3,4] →
 * "1, 2, 3 & 4 BHK". No ranges, no truncation: every config is visible.
 * Empty/null → null (row hidden).
 */
export function formatBedsList(list?: number[] | null): string | null {
  const beds = (list || []).filter((b) => Number.isInteger(b) && b >= 0);
  if (beds.length === 0) return null;
  const uniq = Array.from(new Set(beds)).sort((a, b) => a - b);
  const nums = uniq.filter((b) => b > 0);
  const prefix = uniq.includes(0) ? 'Studio' : null;
  const suffix = tenant.bedsModel === 'bedrooms'
    ? (nums.length === 1 && nums[0] === 1 && !prefix ? ' Bed' : ' Beds')
    : ' BHK';
  const joined = nums.length <= 1
    ? nums.join('')
    : `${nums.slice(0, -1).join(', ')} & ${nums[nums.length - 1]}`;
  if (prefix && joined) return `${prefix}, ${joined}${suffix}`;
  if (prefix) return prefix;
  return `${joined}${suffix}`;
}

/** Possession/delivery date in tenant locale, e.g. "Dec 2027". Null when absent/invalid. */
export function formatPossession(date?: string | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString(tenant.locale, { month: 'short', year: 'numeric' });
  } catch {
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
}

/** Construction progress 0–100; clamps source junk (e.g. 982) to null. */
export function formatProgress(p?: number | null): number | null {
  if (p == null || !Number.isFinite(p) || p <= 0 || p > 100) return null;
  return Math.round(p);
}

export { listingCurrency };
