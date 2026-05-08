/**
 * Unit tests for Rate Limiter (Token Bucket Algorithm)
 *
 * Tests verify:
 * - Token bucket refills at correct rate
 * - Rate limit is enforced per connection
 * - Tokens are consumed correctly
 * - Rate limiter state is initialized correctly
 * - Edge cases: rapid requests, time-based refill, burst handling
 * - Multiple rate limiters work independently
 *
 * Based on backend_design_v1.md section 8:
 * - Per-connection rate limiter for explicit control events
 * - Max RATE_LIMIT_EVENTS_PER_SEC events per second (default 10)
 * - Throttle or reject over-limit messages with ERROR
 */

import { RateLimiter } from '../../utils/rate-limiter';

describe('RateLimiter', () => {
  describe('Initialization', () => {
    it('should create rate limiter with specified tokens per second', () => {
      const rateLimiter = new RateLimiter(10);
      expect(rateLimiter).toBeDefined();
    });

    it('should create initial state with full tokens', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      expect(state.tokens).toBe(10);
      expect(state.lastRefill).toBeGreaterThan(0);
      expect(typeof state.lastRefill).toBe('number');
    });

    it('should initialize with different rate limits', () => {
      const rateLimiter5 = new RateLimiter(5);
      const rateLimiter20 = new RateLimiter(20);

      const state5 = rateLimiter5.createState();
      const state20 = rateLimiter20.createState();

      expect(state5.tokens).toBe(5);
      expect(state20.tokens).toBe(20);
    });
  });

  describe('Token Consumption', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should allow request when tokens are available', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      const allowed = rateLimiter.check(state);
      expect(allowed).toBe(true);
      expect(state.tokens).toBe(9); // One token consumed
    });

    it('should consume exactly one token per check', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Consume multiple tokens
      for (let i = 0; i < 5; i++) {
        const allowed = rateLimiter.check(state);
        expect(allowed).toBe(true);
      }

      expect(state.tokens).toBe(5); // 10 - 5 = 5
    });

    it('should reject request when no tokens available', () => {
      const rateLimiter = new RateLimiter(1);
      const state = rateLimiter.createState();

      // Consume the only token
      const firstCheck = rateLimiter.check(state);
      expect(firstCheck).toBe(true);
      expect(state.tokens).toBe(0);

      // Next check should fail (no time has passed, so no tokens refilled)
      const secondCheck = rateLimiter.check(state);
      expect(secondCheck).toBe(false);
      expect(state.tokens).toBe(0); // Still 0, no token consumed, no time passed to refill
    });

    it('should reject all requests when tokens exhausted', () => {
      const rateLimiter = new RateLimiter(3);
      const state = rateLimiter.createState();

      // Exhaust all tokens
      for (let i = 0; i < 3; i++) {
        expect(rateLimiter.check(state)).toBe(true);
      }

      // All subsequent requests should fail
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.check(state)).toBe(false);
      }

      // Tokens should be 0 (or very close due to floating point precision)
      expect(state.tokens).toBeLessThan(0.01);
    });
  });

  describe('Token Refill', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should refill tokens based on elapsed time', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        rateLimiter.check(state);
      }
      expect(state.tokens).toBe(0);

      // Advance time by 1 second
      jest.advanceTimersByTime(1000);

      // Check should refill tokens (10 tokens per second)
      const allowed = rateLimiter.check(state);
      expect(allowed).toBe(true);
      expect(state.tokens).toBe(9); // 10 refilled - 1 consumed = 9
    });

    it('should refill tokens proportionally to elapsed time', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        rateLimiter.check(state);
      }
      expect(state.tokens).toBe(0);

      // Advance time by 500ms (half a second)
      jest.advanceTimersByTime(500);

      // Should refill 5 tokens (10 tokens/sec * 0.5 sec = 5 tokens)
      const allowed = rateLimiter.check(state);
      expect(allowed).toBe(true);
      expect(state.tokens).toBe(4); // 5 refilled - 1 consumed = 4
    });

    it('should cap tokens at maxTokens', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Advance time by 2 seconds (would give 20 tokens, but capped at 10)
      jest.advanceTimersByTime(2000);

      const allowed = rateLimiter.check(state);
      expect(allowed).toBe(true);
      expect(state.tokens).toBe(9); // Capped at 10, then -1 = 9
    });

    it('should handle multiple refills correctly', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Consume 5 tokens
      for (let i = 0; i < 5; i++) {
        rateLimiter.check(state);
      }
      expect(state.tokens).toBe(5);

      // Advance time by 1 second
      jest.advanceTimersByTime(1000);

      // Should have 10 tokens (5 remaining + 10 refilled, capped at 10)
      const allowed = rateLimiter.check(state);
      expect(allowed).toBe(true);
      expect(state.tokens).toBe(9);
    });

    it('should update lastRefill timestamp', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      const initialRefill = state.lastRefill;

      // Advance time
      jest.advanceTimersByTime(1000);

      rateLimiter.check(state);

      expect(state.lastRefill).toBeGreaterThan(initialRefill);
      expect(state.lastRefill).toBe(initialRefill + 1000);
    });
  });

  describe('Rate Limit Enforcement', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should enforce rate limit of 10 events per second', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // First 10 requests should succeed
      for (let i = 0; i < 10; i++) {
        expect(rateLimiter.check(state)).toBe(true);
      }

      // 11th request should fail
      expect(rateLimiter.check(state)).toBe(false);

      // After 1 second, should allow more requests
      jest.advanceTimersByTime(1000);
      expect(rateLimiter.check(state)).toBe(true);
    });

    it('should allow burst up to maxTokens', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Should allow burst of 10 requests immediately
      for (let i = 0; i < 10; i++) {
        expect(rateLimiter.check(state)).toBe(true);
      }

      // 11th should fail
      expect(rateLimiter.check(state)).toBe(false);
    });

    it('should allow sustained rate at limit', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Send 10 requests immediately
      for (let i = 0; i < 10; i++) {
        expect(rateLimiter.check(state)).toBe(true);
      }

      // Wait 1 second
      jest.advanceTimersByTime(1000);

      // Should allow 10 more requests
      for (let i = 0; i < 10; i++) {
        expect(rateLimiter.check(state)).toBe(true);
      }

      // 11th should fail
      expect(rateLimiter.check(state)).toBe(false);
    });

    it('should handle rapid requests correctly', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Send 20 rapid requests
      const results: boolean[] = [];
      for (let i = 0; i < 20; i++) {
        results.push(rateLimiter.check(state));
      }

      // First 10 should succeed, rest should fail
      expect(results.slice(0, 10).every(r => r === true)).toBe(true);
      expect(results.slice(10).every(r => r === false)).toBe(true);
    });
  });

  describe('Multiple Rate Limiters', () => {
    it('should work independently for different connections', () => {
      const rateLimiter = new RateLimiter(10);
      const state1 = rateLimiter.createState();
      const state2 = rateLimiter.createState();

      // Consume all tokens from state1
      for (let i = 0; i < 10; i++) {
        expect(rateLimiter.check(state1)).toBe(true);
      }
      expect(rateLimiter.check(state1)).toBe(false);

      // state2 should still have tokens
      expect(rateLimiter.check(state2)).toBe(true);
      expect(state2.tokens).toBe(9);
    });

    it('should handle different rate limits independently', () => {
      const rateLimiter5 = new RateLimiter(5);
      const rateLimiter20 = new RateLimiter(20);

      const state5 = rateLimiter5.createState();
      const state20 = rateLimiter20.createState();

      // Consume all tokens from rateLimiter5
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter5.check(state5)).toBe(true);
      }
      expect(rateLimiter5.check(state5)).toBe(false);

      // rateLimiter20 should still allow requests
      for (let i = 0; i < 20; i++) {
        expect(rateLimiter20.check(state20)).toBe(true);
      }
      expect(rateLimiter20.check(state20)).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should handle zero tokens per second', () => {
      const rateLimiter = new RateLimiter(0);
      const state = rateLimiter.createState();

      expect(state.tokens).toBe(0);
      expect(rateLimiter.check(state)).toBe(false);
    });

    it('should handle very small time increments', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        rateLimiter.check(state);
      }

      // Advance by 1ms
      jest.advanceTimersByTime(1);

      // Should refill a tiny amount (10 tokens/sec * 0.001 sec = 0.01 tokens)
      // But since we need >= 1 token, this should fail
      expect(rateLimiter.check(state)).toBe(false);
    });

    it('should handle very large time increments', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        rateLimiter.check(state);
      }

      // Advance by 1 hour (3600000ms)
      jest.advanceTimersByTime(3600000);

      // Should be capped at maxTokens (10)
      const allowed = rateLimiter.check(state);
      expect(allowed).toBe(true);
      expect(state.tokens).toBe(9); // Capped at 10, then -1
    });

    it('should handle state mutation correctly', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      const initialTokens = state.tokens;
      const initialRefill = state.lastRefill;

      // Advance time slightly to ensure lastRefill changes
      jest.advanceTimersByTime(1);
      rateLimiter.check(state);

      // State should be mutated
      expect(state.tokens).not.toBe(initialTokens);
      expect(state.lastRefill).toBeGreaterThanOrEqual(initialRefill);
    });

    it('should handle fractional token refills correctly', () => {
      const rateLimiter = new RateLimiter(3); // 3 tokens per second
      const state = rateLimiter.createState();

      // Consume all tokens
      for (let i = 0; i < 3; i++) {
        rateLimiter.check(state);
      }

      // Advance by 400ms (should give 1.2 tokens: 3 tokens/sec * 0.4 sec = 1.2 tokens)
      jest.advanceTimersByTime(400);

      // Should allow one request (1.2 tokens >= 1)
      const allowed = rateLimiter.check(state);
      expect(allowed).toBe(true);
      // Should have approximately 0.2 tokens left (1.2 refilled - 1 consumed)
      expect(state.tokens).toBeLessThan(0.3);
      expect(state.tokens).toBeGreaterThan(0);
    });
  });

  describe('Real-world Scenarios', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should handle default rate limit of 10 events per second', () => {
      const rateLimiter = new RateLimiter(10); // Default from backend_design_v1.md
      const state = rateLimiter.createState();

      // Simulate rapid burst of events
      const results: boolean[] = [];
      for (let i = 0; i < 15; i++) {
        results.push(rateLimiter.check(state));
      }

      // First 10 should succeed
      expect(results.slice(0, 10).filter(r => r).length).toBe(10);
      // Next 5 should fail
      expect(results.slice(10).filter(r => r).length).toBe(0);

      // After 1 second, should allow more
      jest.advanceTimersByTime(1000);
      expect(rateLimiter.check(state)).toBe(true);
    });

    it('should handle sustained rate at limit over time', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Simulate 3 seconds of activity
      for (let second = 0; second < 3; second++) {
        // Each second, consume 10 tokens
        for (let i = 0; i < 10; i++) {
          const allowed = rateLimiter.check(state);
          expect(allowed).toBe(true);
        }

        // 11th request in this second should fail
        expect(rateLimiter.check(state)).toBe(false);

        // Advance to next second
        jest.advanceTimersByTime(1000);
      }
    });

    it('should handle irregular request patterns', () => {
      const rateLimiter = new RateLimiter(10);
      const state = rateLimiter.createState();

      // Send 5 requests
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.check(state)).toBe(true);
      }

      // Wait 2 seconds
      jest.advanceTimersByTime(2000);

      // Should have full tokens (capped at 10)
      expect(state.tokens).toBeLessThanOrEqual(10);

      // Should allow 10 more requests
      for (let i = 0; i < 10; i++) {
        expect(rateLimiter.check(state)).toBe(true);
      }

      // 11th should fail
      expect(rateLimiter.check(state)).toBe(false);
    });
  });
});
