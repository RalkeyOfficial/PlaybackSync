/**
 * Simple token bucket rate limiter for per-connection rate limiting
 * Implements a token bucket algorithm with configurable rate
 */

/**
 * Rate limiter state for a single connection
 */
export interface RateLimiterState {
  /** Number of tokens currently available */
  tokens: number;
  /** Last time tokens were refilled (milliseconds) */
  lastRefill: number;
}

/**
 * Token bucket rate limiter
 * Refills tokens at a fixed rate (tokens per second)
 */
export class RateLimiter {
  private readonly maxTokens: number;
  private readonly tokensPerSecond: number;

  /**
   * Create a new rate limiter
   * @param tokensPerSecond - Number of tokens to allow per second
   */
  constructor(tokensPerSecond: number) {
    this.maxTokens = tokensPerSecond;
    this.tokensPerSecond = tokensPerSecond;
  }

  /**
   * Check if a request is allowed and consume a token if so
   * @param state - Current rate limiter state (mutated in place)
   * @returns True if request is allowed, false if rate limit exceeded
   */
  check(state: RateLimiterState): boolean {
    const now = Date.now();
    const elapsed = (now - state.lastRefill) / 1000; // Convert to seconds

    // Refill tokens based on elapsed time
    const tokensToAdd = elapsed * this.tokensPerSecond;
    state.tokens = Math.min(this.maxTokens, state.tokens + tokensToAdd);
    state.lastRefill = now;

    // Check if we have at least one token
    if (state.tokens >= 1) {
      state.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Create initial rate limiter state
   * @returns Initial state with full tokens
   */
  createState(): RateLimiterState {
    return {
      tokens: this.maxTokens,
      lastRefill: Date.now(),
    };
  }
}
