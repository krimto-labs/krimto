// Gap 18 — Rate limiting. Fixed-window per key. Off by default for self-host;
// X-RateLimit-* headers are always emitted so clients can adapt. 429 carries Retry-After.

export interface RateLimitConfig {
  enabled: boolean;
  perKeyPerMinute: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window resets. */
  reset: number;
  /** Seconds to wait, present only when not allowed. */
  retryAfter?: number;
}

const WINDOW_MS = 60_000;
const UNLIMITED = Number.MAX_SAFE_INTEGER;

export class RateLimiter {
  private readonly windows = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  check(key: string): RateLimitResult {
    const now = this.clock();
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const reset = Math.ceil((windowStart + WINDOW_MS) / 1000);

    if (!this.config.enabled) {
      return { allowed: true, limit: UNLIMITED, remaining: UNLIMITED, reset };
    }

    const limit = this.config.perKeyPerMinute;
    let window = this.windows.get(key);
    if (!window || window.windowStart !== windowStart) {
      window = { count: 0, windowStart };
      this.windows.set(key, window);
    }

    if (window.count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        reset,
        retryAfter: Math.ceil((windowStart + WINDOW_MS - now) / 1000),
      };
    }

    window.count++;
    return { allowed: true, limit, remaining: limit - window.count, reset };
  }

  headers(result: RateLimitResult): Record<string, string> {
    return {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.reset),
    };
  }
}
