<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\RateLimiter;
use PHPUnit\Framework\TestCase;

class RateLimiterTest extends TestCase {

	public function testStartsFullAndAllowsBurstUpToCapacity(): void {
		$limiter = new RateLimiter(ratePerSecond: 5, nowMs: 1000);
		for ($i = 0; $i < 5; $i++) {
			$this->assertTrue($limiter->tryConsume(1000), "burst event $i should pass");
		}
		$this->assertFalse($limiter->tryConsume(1000), 'sixth event in same instant must be rejected');
	}

	public function testTokensRefillOverTime(): void {
		$limiter = new RateLimiter(ratePerSecond: 10, nowMs: 0);
		// Drain.
		for ($i = 0; $i < 10; $i++) {
			$limiter->tryConsume(0);
		}
		$this->assertFalse($limiter->tryConsume(0));
		// Half a second later: 5 tokens have refilled.
		$this->assertTrue($limiter->tryConsume(500));
	}

	public function testRefillIsCappedAtCapacity(): void {
		$limiter = new RateLimiter(ratePerSecond: 3, nowMs: 0);
		// Drain.
		$limiter->tryConsume(0);
		$limiter->tryConsume(0);
		$limiter->tryConsume(0);
		// Sit idle for ten seconds — tokens should cap at 3, not 30.
		for ($i = 0; $i < 3; $i++) {
			$this->assertTrue($limiter->tryConsume(10_000));
		}
		$this->assertFalse($limiter->tryConsume(10_000));
	}
}
