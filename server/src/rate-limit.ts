/**
 * Simple rate limiter using token bucket algorithm
 */

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
    
    // Clean up old timestamps periodically
    setInterval(() => this.cleanup(), this.config.windowMs);
  }

  isAllowed(identifier: string): boolean {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let timestamps = this.requests.get(identifier) || [];
    
    // Filter out timestamps outside the current window
    timestamps = timestamps.filter((ts) => ts > windowStart);
    
    // Check if under limit
    if (timestamps.length < this.config.maxRequests) {
      timestamps.push(now);
      this.requests.set(identifier, timestamps);
      return true;
    }

    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    for (const [identifier, timestamps] of this.requests.entries()) {
      const filtered = timestamps.filter((ts) => ts > windowStart);
      if (filtered.length === 0) {
        this.requests.delete(identifier);
      } else {
        this.requests.set(identifier, filtered);
      }
    }
  }

  getRemainingRequests(identifier: string): number {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const timestamps = this.requests.get(identifier) || [];
    const recentCount = timestamps.filter((ts) => ts > windowStart).length;
    return Math.max(0, this.config.maxRequests - recentCount);
  }

  reset(identifier: string): void {
    this.requests.delete(identifier);
  }
}

// Rate limiters for different services
export const apolloRateLimiter = new RateLimiter({
  maxRequests: 100,
  windowMs: 60 * 1000, // 100 requests per minute
});

export const llmRateLimiter = new RateLimiter({
  maxRequests: 50,
  windowMs: 60 * 1000, // 50 requests per minute
});

export const generalRateLimiter = new RateLimiter({
  maxRequests: 1000,
  windowMs: 60 * 1000, // 1000 requests per minute
});
