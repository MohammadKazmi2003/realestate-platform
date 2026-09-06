import type { PricePurpose } from './priceScale';

// Intent model: Buy (DB 'Sell') | Rent | Lease | PG.
// No 'All': it mixes sale totals with monthly rents (meaningless sort/slider),
// and buying properties+projects is already covered by Buy + 'Both' scope.
// /browse tabs show Buy|Rent only; /list exposes all four via dropdown.
// Projects are sale inventory → hidden on Rent (and Lease/PG server-side).
export type Intent = 'buy' | 'rent' | 'lease' | 'pg';

export const INTENT_PARAM = 'intent';

const SELL_LABELS = new Set(['sell', 'sale']);

/** Canonical DB label for an intent. Buy→'Sell' (DB canonical; ES holds 'Sell'). */
export function intentToListingPurpose(intent: Intent): string | undefined {
  if (intent === 'buy') return 'Sell';
  if (intent === 'rent') return 'Rent';
  if (intent === 'lease') return 'Lease';
  if (intent === 'pg') return 'PG';
  return undefined;
}

/** User-facing display label for an intent. Sell→Buy (buyer's perspective). */
export function intentDisplayLabel(intent: Intent): string {
  if (intent === 'buy') return 'Buy';
  if (intent === 'rent') return 'Rent';
  if (intent === 'lease') return 'Lease';
  return 'PG';
}

/** User-facing display for a raw DB purpose label. Sell→Buy. */
export function purposeDisplayLabel(raw?: string | null): string {
  const norm = normalizeListingPurposeLabel(raw);
  if (norm === 'Sell') return 'Buy';
  return norm ?? '';
}

/** Normalize a raw purpose label to canonical DB label. Sale→Sell. */
export function normalizeListingPurposeLabel(raw?: string | null): string | undefined {
  if (raw == null) return undefined;
  const t = String(raw).trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  if (SELL_LABELS.has(lower)) return 'Sell';
  if (lower === 'rent') return 'Rent';
  if (lower === 'lease') return 'Lease';
  if (lower === 'pg') return 'PG';
  return t;
}

/** ES filter values for a raw purpose: Buy matches both Sell+Sale variants (robust to legacy docs). */
export function listingPurposeFilterValues(raw?: string | null): string[] | undefined {
  const norm = normalizeListingPurposeLabel(raw);
  if (!norm) return undefined;
  if (norm === 'Sell') return ['Sell', 'Sale'];
  return [norm];
}

/** Intent from a raw purpose label. */
export function intentFromListingPurpose(raw?: string | null): Intent {
  const norm = normalizeListingPurposeLabel(raw);
  if (norm === 'Rent') return 'rent';
  if (norm === 'Lease') return 'lease';
  if (norm === 'PG') return 'pg';
  return 'buy';
}

/** Price scale purpose for an intent (rent bands for Rent/Lease/PG). */
export function pricePurposeForIntent(intent: Intent): PricePurpose {
  return intent === 'buy' ? 'sale' : 'rent';
}

/** Rent-like purposes (Rent/Lease/PG) exclude for-sale projects. */
export function isRentLikePurpose(raw?: string | null): boolean {
  if (typeof raw !== 'string') return false;
  return /rent|lease|\bpg\b/i.test(raw);
}

/** Parse ?intent= from a query string. Defaults to 'buy'; legacy 'all' maps to 'buy'. */
export function parseIntentFromSearch(search?: string | null): Intent {
  if (!search) return 'buy';
  const q = search.startsWith('?') ? search.slice(1) : search;
  const m = q.match(/(?:^|&)intent=(buy|rent|lease|pg|all)\b/i);
  if (!m) return 'buy';
  const v = m[1].toLowerCase();
  if (v === 'rent') return 'rent';
  if (v === 'lease') return 'lease';
  if (v === 'pg') return 'pg';
  return 'buy';
}

/** Write ?intent= into existing search string (preserves other params). */
export function withIntentInSearch(search: string, intent: Intent): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.set(INTENT_PARAM, intent);
  const s = params.toString();
  return s ? `?${s}` : '';
}
