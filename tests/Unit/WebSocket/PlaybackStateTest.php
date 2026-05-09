<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\PlaybackState;
use PHPUnit\Framework\TestCase;

class PlaybackStateTest extends TestCase {

	public function testPausedExpectedTimeReturnsVideoPos(): void {
		$state = new PlaybackState(PlaybackState::PAUSED, 42.0, 1000, 1000, 0);
		$this->assertSame(42.0, $state->expectedTime(5000));
	}

	public function testPlayingExpectedTimeAdvancesWithWallClock(): void {
		$state = new PlaybackState(PlaybackState::PLAYING, 10.0, 1000, 1000, 0);
		$this->assertEqualsWithDelta(15.0, $state->expectedTime(6000), 0.0001);
	}

	public function testPlayingExpectedTimeNeverGoesBackwards(): void {
		// nowMs < lastStateUpdateTs is a clock-skew edge case; we clamp to 0.
		$state = new PlaybackState(PlaybackState::PLAYING, 10.0, 5000, 5000, 0);
		$this->assertSame(10.0, $state->expectedTime(1000));
	}

	public function testApplyPlaySnapsBaselineToExtrapolatedTime(): void {
		$state = new PlaybackState(PlaybackState::PAUSED, 10.0, 0, 0, 0);
		$eventId = $state->applyPlay(2000);
		$this->assertSame(1, $eventId);
		$this->assertSame(PlaybackState::PLAYING, $state->playerState);
		$this->assertSame(10.0, $state->videoPos);
		$this->assertSame(2000, $state->lastExplicitEventTs);
	}

	public function testApplyPauseFreezesAtCurrentExtrapolatedTime(): void {
		$state = new PlaybackState(PlaybackState::PLAYING, 10.0, 1000, 1000, 5);
		$eventId = $state->applyPause(4000);
		$this->assertSame(6, $eventId);
		$this->assertSame(PlaybackState::PAUSED, $state->playerState);
		$this->assertEqualsWithDelta(13.0, $state->videoPos, 0.0001);
	}

	public function testApplySeekClampsNegativeAndUpdatesEventId(): void {
		$state = new PlaybackState(PlaybackState::PAUSED, 0.0, 0, 0, 10);
		$eventId = $state->applySeek(-3.0, 5000);
		$this->assertSame(11, $eventId);
		$this->assertSame(0.0, $state->videoPos);
	}

	public function testApplyEpisodeResetReturnsToZeroPaused(): void {
		$state = new PlaybackState(PlaybackState::PLAYING, 120.0, 1000, 1000, 7);
		$state->applyEpisodeReset(8000);
		$this->assertSame(0.0, $state->videoPos);
		$this->assertSame(PlaybackState::PAUSED, $state->playerState);
		$this->assertSame(8, $state->eventId);
	}

	public function testIsInCooldownTrueWithinWindow(): void {
		$state = new PlaybackState(PlaybackState::PLAYING, 0.0, 1000, 1000, 0);
		$this->assertTrue($state->isInCooldown(2000, 3000));
		$this->assertFalse($state->isInCooldown(5000, 3000));
	}

	public function testEventIdIncrementsMonotonicallyAcrossActions(): void {
		$state = new PlaybackState();
		$ids = [
			$state->applyPlay(100),
			$state->applySeek(30.0, 200),
			$state->applyPause(300),
			$state->applyEpisodeReset(400),
		];
		$this->assertSame([1, 2, 3, 4], $ids);
	}
}
