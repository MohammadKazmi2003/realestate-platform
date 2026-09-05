import defaultTenantJson from '../../tenants/default.json';

export interface MoneyStep {
  gte: number;
  div: number;
  digits: number;
  suffix: string;
}

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
  };
}

export const tenant: TenantConfig = loadTenant();

export function listingCurrency(entityType?: string): string {
  if (entityType === 'project') return tenant.projectCurrency;
  return tenant.propertyCurrency;
}
