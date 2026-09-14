// Pure helpers for map-tile click cards (kept import-light so they stay
// unit-testable without pulling maplibre-gl or page modules).

/**
 * Single-photo tiles (authoritative image_count from the marker) already
 * render the complete card — gallery included — so the click fetch can be
 * skipped entirely. Unknown counts (docs indexed before the field existed,
 * null) must still fetch.
 */
export function tileGalleryComplete(imageCount: number | null | undefined): boolean {
  return typeof imageCount === 'number' && imageCount <= 1;
}

/** MapLibre drops null props and stringifies array props on rendered
 * features — normalize both back before building the click card. */
export function tileStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (typeof v === 'string' && v.length > 0) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) {
        return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
      }
    } catch { /* fall through to [] */ }
  }
  return [];
}

export function tileNumberArray(v: unknown): number[] {
  if (Array.isArray(v)) return v.filter((u): u is number => typeof u === 'number' && Number.isFinite(u));
  if (typeof v === 'string' && v.length > 0) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) {
        return parsed.filter((u): u is number => typeof u === 'number' && Number.isFinite(u));
      }
    } catch { /* fall through to [] */ }
  }
  return [];
}
