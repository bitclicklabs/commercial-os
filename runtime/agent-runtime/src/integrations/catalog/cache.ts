/**
 * In-memory TTL cache of catalog answers. The catalog is not our state: nothing is persisted in
 * the database, a restart simply starts cold. TTL per operation (docs/catalog-service.md):
 * families and describe 1 h, product sheet 10 min, search 5 min. The customization estimate is
 * not cached (it goes apart from the sheet precisely so the sheet stays cacheable). Concurrent
 * misses of the same key share one in-flight call. Errors are never cached.
 */
export const CATALOG_CACHE_TTL_MS = {
  families: 3_600_000,
  describe: 3_600_000,
  product: 600_000,
  search: 300_000,
} as const;
export type CatalogCacheKind = keyof typeof CATALOG_CACHE_TTL_MS;

export class TtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly maxEntries = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.entries.delete(key);
    // Oldest insertion goes first when full (Map keeps insertion order).
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Cached value of `key`, or the result of `load` (stored for `ttlMs`; errors are not stored). */
  async memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    this.misses += 1;
    const p = load()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
