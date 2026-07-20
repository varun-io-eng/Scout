/**
 * Simple in-memory cache with TTL support
 * For production, consider Redis or similar distributed cache
 */

interface CacheEntry {
  value: any;
  expiresAt: number;
}

class Cache {
  private store: Map<string, CacheEntry> = new Map();
  private defaultTtl: number;

  constructor(defaultTtlMs: number = 5 * 60 * 1000) {
    this.defaultTtl = defaultTtlMs;
  }

  set(key: string, value: any, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtl;
    const expiresAt = Date.now() + ttl;
    this.store.set(key, { value, expiresAt });
  }

  get(key: string): any {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  // Clean up expired entries
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }
}

export { Cache };

// Singleton instances for different cache types
export const apolloCache = new Cache(15 * 60 * 1000); // 15 minutes
export const llmCache = new Cache(30 * 60 * 1000); // 30 minutes

// Periodic cleanup
setInterval(() => {
  apolloCache.cleanup();
  llmCache.cleanup();
}, 5 * 60 * 1000); // Every 5 minutes
