<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

/**
 * Mutable, in-memory playback state for one room.
 *
 * Time math is server-authoritative: clients report what they see, the server
 * decides what's correct. `expectedTime()` extrapolates from the last
 * server-acknowledged update, which is what late joiners and drift checks
 * compare against.
 */
class PlaybackState {
	public const PLAYING = 'playing';
	public const PAUSED = 'paused';

	public function __construct(
		public string $playerState = self::PAUSED,
		public float $videoPos = 0.0,
		public int $lastExplicitEventTs = 0,
		public int $lastStateUpdateTs = 0,
		public int $eventId = 0,
	) {
	}

	/**
	 * Where the room "should" be right now, in seconds.
	 *
	 * If paused, the position hasn't moved since `lastStateUpdateTs`.
	 * If playing, the position is the recorded `videoPos` plus the wall-clock
	 * elapsed since that update.
	 */
	public function expectedTime(int $nowMs): float {
		if ($this->playerState === self::PAUSED) {
			return $this->videoPos;
		}
		$elapsedSeconds = max(0, $nowMs - $this->lastStateUpdateTs) / 1000.0;
		return $this->videoPos + $elapsedSeconds;
	}

	public function applyPlay(int $nowMs): int {
		// Snap videoPos to the extrapolated value so the playback baseline
		// matches the moment we transition to playing.
		$this->videoPos = $this->expectedTime($nowMs);
		$this->playerState = self::PLAYING;
		$this->lastExplicitEventTs = $nowMs;
		$this->lastStateUpdateTs = $nowMs;
		return ++$this->eventId;
	}

	public function applyPause(int $nowMs): int {
		$this->videoPos = $this->expectedTime($nowMs);
		$this->playerState = self::PAUSED;
		$this->lastExplicitEventTs = $nowMs;
		$this->lastStateUpdateTs = $nowMs;
		return ++$this->eventId;
	}

	public function applySeek(float $pos, int $nowMs): int {
		$this->videoPos = max(0.0, $pos);
		$this->lastExplicitEventTs = $nowMs;
		$this->lastStateUpdateTs = $nowMs;
		return ++$this->eventId;
	}

	/**
	 * Episode-change hard reset: paused at zero, eventId continues monotonic.
	 */
	public function applyEpisodeReset(int $nowMs): int {
		$this->videoPos = 0.0;
		$this->playerState = self::PAUSED;
		$this->lastExplicitEventTs = $nowMs;
		$this->lastStateUpdateTs = $nowMs;
		return ++$this->eventId;
	}

	public function isInCooldown(int $nowMs, int $cooldownMs): bool {
		return ($nowMs - $this->lastExplicitEventTs) < $cooldownMs;
	}
}
