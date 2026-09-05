// Small in-memory LRU cache of full listing details for map clicks.
// Keyed by `${type}:${id}` so property/project ids can never collide.
// Clicking A → B → A reuses the stored full response (with gallery);
// eviction keeps memory bounded. Hover paths never touch the network and
// never fill this cache — hover renders only from data already in hand.
export interface HoverPointEntry {
  id: string;
  type: 'property' | 'project';
  lat: number;
  lon: number;
  title?: string;
  price?: number;
  image?: string;
  location?: string;
  // Full click details (filled only by click responses, never by hover).
  all_images?: string[];
  bhk_type?: string | null;
  bathrooms?: number | null;
  balconies?: number | null;
  furnishing_status?: string | null;
  listing_purpose?: string | null;
  area_sqft?: number | null;
  area_unit?: string | null;
  location_text?: string | null;
  low_price?: number | null;
  high_price?: number | null;
  developer_name?: string | null;
  construction_phase?: string | null;
  delivery_date?: string | null;
  property_type?: string | null;
  amenities?: string[];
  amenities_total?: number | null;
  bedrooms_list?: number[];
  unit_count?: number | null;
  payment_plan_summary?: string | null;
  construction_progress_percent?: number | null;
}

export class MarkerLruCache {
  private cache = new Map<string, HoverPointEntry>();

  constructor(private readonly max = 50) {}

  get(key: string): HoverPointEntry | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Refresh recency
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: HoverPointEntry): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    if (this.cache.size > this.max) {
      // Evict least-recently-used (first inserted key)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }
}
