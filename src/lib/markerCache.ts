// Small in-memory LRU cache of hovered-listing markers. Keyed by `${type}:${id}`
// so property/project ids can never collide. Hovering A → B → A costs one
// network fetch total; eviction keeps memory bounded (50 entries).
export interface HoverPointEntry {
  id: string;
  type: 'property' | 'project';
  lat: number;
  lon: number;
  title?: string;
  price?: number;
  image?: string;
  location?: string;
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
