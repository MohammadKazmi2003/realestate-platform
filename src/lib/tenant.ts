import defaultTenantJson from '../../tenants/default.json';

export interface MoneyStep {
  gte: number;
  div: number;
  digits: number;
  suffix: string;
}

export interface PriceTier {
  upTo: number;
  step: number;
}

export interface PriceScale {
  min: number;
  max: number;
  ceilLabel?: string;
  tiers: PriceTier[];
}

export type PricePurpose = 'sale' | 'rent';

export interface FilterNormalizationConfig {
  priceSteps: Record<string, number>;
  areaStep: number;
  radiusStep: number;
  arrayFields: string[];
  stripFromMarkerKey: string[];
  polygonMaxPoints: number;
  polygonPrecision: number;
}

const DEFAULT_FILTER_NORMALIZATION: FilterNormalizationConfig = {
  priceSteps: { INR: 500000, AED: 50000, USD: 25000 },
  areaStep: 100,
  radiusStep: 5,
  arrayFields: ['amenities', 'furnishings'],
  stripFromMarkerKey: ['sort', 'pageSize', 'cursor'],
  polygonMaxPoints: 50,
  polygonPrecision: 4,
};

export interface TenantConfig {
  slug: string;
  brand: { name: string };
  locale: string;
  currency: string;
  propertyCurrency: string;
  projectCurrency: string;
  moneyCompact: Record<string, { symbol: string; steps: MoneyStep[] }>;
  bedsModel: 'bhk' | 'bedrooms';
  bedsLabel: string;
  areaUnit: string;
  map: { center: [number, number]; zoom: number; geocodeCountries: string };
  features: { projects: boolean };
  filterNormalization: FilterNormalizationConfig;
  priceScales?: Record<string, Record<PricePurpose, PriceScale>>;
}

// Buyer white-labels register their file here (one line per tenant).
// Unknown NEXT_PUBLIC_TENANT falls back to default with a console warning.
const defaultTenant = defaultTenantJson as unknown as TenantConfig;
const registry: Record<string, TenantConfig> = {
  default: defaultTenant,
};

function parseCenter(raw: string | undefined, fallback: [number, number]): [number, number] {
  if (!raw) return fallback;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return fallback;
  return [parts[0], parts[1]];
}

function sanitizePriceScales(
  raw: unknown,
  priceSteps: Record<string, number>
): Record<string, Record<PricePurpose, PriceScale>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, Record<PricePurpose, PriceScale>> = {};
  for (const [code, purposes] of Object.entries(raw as Record<string, unknown>)) {
    if (code.startsWith('$') || !purposes || typeof purposes !== 'object') continue;
    const cleanPurposes: Partial<Record<PricePurpose, PriceScale>> = {};
    for (const purpose of ['sale', 'rent'] as const) {
      const s = (purposes as Record<string, unknown>)[purpose];
      if (!s || typeof s !== 'object') continue;
      const rec = s as Record<string, unknown>;
      const min = Number(rec.min);
      const max = Number(rec.max);
      const tiersRaw = Array.isArray(rec.tiers) ? rec.tiers : [];
      const tiers: PriceTier[] = [];
      for (const t of tiersRaw) {
        if (!t || typeof t !== 'object') continue;
        const upTo = Number((t as Record<string, unknown>).upTo);
        const step = Number((t as Record<string, unknown>).step);
        if (!Number.isFinite(upTo) || !Number.isFinite(step) || upTo <= 0 || step <= 0) continue;
        tiers.push({ upTo, step });
      }
      tiers.sort((a, b) => a.upTo - b.upTo);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || tiers.length === 0) continue;
      // Last tier must cover max so every value has a step.
      const last = tiers[tiers.length - 1];
      if (last.upTo < max) tiers.push({ upTo: max, step: last.step });
      cleanPurposes[purpose] = {
        min: Math.max(0, min),
        max,
        ceilLabel: typeof rec.ceilLabel === 'string' ? rec.ceilLabel : undefined,
        tiers,
      };
    }
    // Require at least sale; rent falls back to sale when absent so older
    // configs keep working without duplication.
    if (cleanPurposes.sale) {
      out[code] = { sale: cleanPurposes.sale, rent: cleanPurposes.rent ?? cleanPurposes.sale };
    } else if (Object.keys(priceSteps).includes(code)) {
      const step = priceSteps[code];
      const max = Math.max(step * 400, step);
      const fallback: PriceScale = { min: 0, max, tiers: [{ upTo: max, step }] };
      out[code] = { sale: fallback, rent: fallback };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function loadTenant(): TenantConfig {
  const slug = process.env.NEXT_PUBLIC_TENANT || 'default';
  const base = registry[slug];
  if (!base) {
    if (typeof console !== 'undefined') {
      console.warn(`[tenant] Unknown NEXT_PUBLIC_TENANT="${slug}", falling back to "default".`);
    }
    return registry.default;
  }
  // Shallow env overrides so a deployment can tweak identity/geo without
  // forking the JSON file. Currency stays in JSON (needs compact steps).
  // filterNormalization merges over defaults so older tenant files keep working.
  const filterNormalization: FilterNormalizationConfig = {
    ...DEFAULT_FILTER_NORMALIZATION,
    ...(base.filterNormalization || {}),
  };
  const priceScales = sanitizePriceScales(
    (base as Record<string, unknown>).priceScales,
    filterNormalization.priceSteps
  );
  return {
    ...base,
    brand: {
      ...base.brand,
      name: process.env.NEXT_PUBLIC_BRAND_NAME || base.brand.name,
    },
    locale: process.env.NEXT_PUBLIC_LOCALE || base.locale,
    currency: process.env.NEXT_PUBLIC_CURRENCY || base.currency,
    propertyCurrency: process.env.NEXT_PUBLIC_PROPERTY_CURRENCY || base.propertyCurrency,
    projectCurrency: process.env.NEXT_PUBLIC_PROJECT_CURRENCY || base.projectCurrency,
    map: {
      center: parseCenter(process.env.NEXT_PUBLIC_MAP_CENTER, base.map.center),
      zoom: process.env.NEXT_PUBLIC_MAP_ZOOM ? Number(process.env.NEXT_PUBLIC_MAP_ZOOM) || base.map.zoom : base.map.zoom,
      geocodeCountries: process.env.NEXT_PUBLIC_GEOCODE_COUNTRIES ?? base.map.geocodeCountries,
    },
    filterNormalization,
    ...(priceScales ? { priceScales } : {}),
  };
}

export const tenant: TenantConfig = loadTenant();

export function listingCurrency(entityType?: string): string {
  if (entityType === 'project') return tenant.projectCurrency;
  return tenant.propertyCurrency;
}
