<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

/**
 * Per-connection token bucket. Capacity equals the per-second rate, so the
 * bucket starts full and refills smoothly; one event consumes one token.
 *
 * Used to throttle explicit playback events (`EVENT`, `EPISODE_CHANGE_REQUEST`)
 * — a misbehaving client can't flood the room with seek storms.
 */
class RateLimiter {
	private float $tokens;
	private int $lastRefillMs;

	public function __construct(
		private readonly int $ratePerSecond,
		int $nowMs,
	) {
		$this->tokens = (float)$ratePerSecond;
		$this->lastRefillMs = $nowMs;
	}

	public function tryConsume(int $nowMs): bool {
		$this->refill($nowMs);
		if ($this->tokens >= 1.0) {
			$this->tokens -= 1.0;
			return true;
		}
		return false;
	}

	private function refill(int $nowMs): void {
		$elapsedMs = max(0, $nowMs - $this->lastRefillMs);
		if ($elapsedMs === 0) {
			return;
		}
		$this->tokens = min(
			(float)$this->ratePerSecond,
			$this->tokens + ($elapsedMs / 1000.0) * $this->ratePerSecond,
		);
		$this->lastRefillMs = $nowMs;
	}
}
