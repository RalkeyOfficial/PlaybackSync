<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use Ratchet\ConnectionInterface;

/**
 * Per-client state. Held inside a RoomRuntime; one instance per connected
 * (or recently disconnected) client.
 *
 * `tombstonedUntilMs` lets a client reconnect with the same `clientId` within
 * a grace window and pick up event replay from where it left off. While
 * tombstoned, `conn` is null — the previous WebSocket is gone — but everything
 * else (rate-limit bucket, lastEventId, clock offset) is preserved.
 */
class ClientConnection {
	public ?ConnectionInterface $conn;
	public int $lastSeenMs;
	public ?int $tombstonedUntilMs = null;
	public int $lastEventId;
	public ?float $clockOffsetMs = null;
	public ?float $rttMs = null;
	public bool $isBuffering = false;
	public RateLimiter $rateLimiter;

	public function __construct(
		public readonly string $clientId,
		?ConnectionInterface $conn,
		int $nowMs,
		int $lastEventId,
		RateLimiter $rateLimiter,
	) {
		$this->conn = $conn;
		$this->lastSeenMs = $nowMs;
		$this->lastEventId = $lastEventId;
		$this->rateLimiter = $rateLimiter;
	}

	public function markSeen(int $nowMs): void {
		$this->lastSeenMs = $nowMs;
	}

	public function tombstone(int $untilMs): void {
		$this->conn = null;
		$this->tombstonedUntilMs = $untilMs;
	}

	public function reattach(ConnectionInterface $conn, int $nowMs): void {
		$this->conn = $conn;
		$this->tombstonedUntilMs = null;
		$this->lastSeenMs = $nowMs;
	}

	public function isTombstoned(int $nowMs): bool {
		return $this->tombstonedUntilMs !== null && $this->tombstonedUntilMs > $nowMs;
	}

	public function isExpiredTombstone(int $nowMs): bool {
		return $this->tombstonedUntilMs !== null && $this->tombstonedUntilMs <= $nowMs;
	}

	public function isIdle(int $nowMs, int $idleMs): bool {
		return $this->conn !== null && ($nowMs - $this->lastSeenMs) >= $idleMs;
	}
}
