<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use Ratchet\ConnectionInterface;

/**
 * Live state for one room: playback, members, recent events. Pure value
 * object — no I/O — so it's trivial to unit-test the lifecycle without
 * spinning up a network stack.
 *
 * The event log is a fixed-size ring buffer indexed by monotonic `eventId`;
 * a reconnecting client passes its last seen `eventId` and we replay just
 * the tail it missed.
 */
class RoomRuntime {
	/** @var array<string, ClientConnection> */
	private array $clients = [];

	/** @var array<int, array{type: string, value?: mixed, clientId: string, ts: int, eventId: int}> */
	private array $eventLog = [];

	public ?ContentIdentity $contentIdentity = null;
	public PlaybackState $state;

	public function __construct(
		public readonly string $uuid,
		public int $expiresAtMs,
		public readonly int $eventLogSize = 200,
	) {
		$this->state = new PlaybackState();
	}

	public function isExpired(int $nowMs): bool {
		return $this->expiresAtMs <= $nowMs;
	}

	public function addClient(ClientConnection $client): void {
		$this->clients[$client->clientId] = $client;
	}

	public function getClient(string $clientId): ?ClientConnection {
		return $this->clients[$clientId] ?? null;
	}

	public function removeClient(string $clientId): void {
		unset($this->clients[$clientId]);
	}

	/**
	 * @return array<string, ClientConnection>
	 */
	public function clients(): array {
		return $this->clients;
	}

	public function clientCount(): int {
		return count($this->clients);
	}

	/**
	 * Wall-clock timestamp of the most recent activity in this room, in
	 * milliseconds. Defined as the latest of (a) any client's `lastSeenMs`
	 * and (b) the most recent event's `ts`. Returns `null` for a room that
	 * has never had a client (i.e. the runtime was created speculatively
	 * but no one ever joined) — callers can render that as "no activity".
	 */
	public function lastActivityMs(): ?int {
		$max = null;
		foreach ($this->clients as $client) {
			if ($max === null || $client->lastSeenMs > $max) {
				$max = $client->lastSeenMs;
			}
		}
		$tail = end($this->eventLog);
		if ($tail !== false && ($max === null || $tail['ts'] > $max)) {
			$max = $tail['ts'];
		}
		return $max;
	}

	/**
	 * Append an event to the ring buffer. The buffer never exceeds
	 * `eventLogSize` entries — older events are dropped silently because any
	 * client that needed them missed its tombstone window anyway.
	 */
	public function pushEvent(string $type, mixed $value, string $clientId, int $tsMs, int $eventId): void {
		$this->eventLog[] = [
			'type' => $type,
			'value' => $value,
			'clientId' => $clientId,
			'ts' => $tsMs,
			'eventId' => $eventId,
		];
		if (count($this->eventLog) > $this->eventLogSize) {
			array_shift($this->eventLog);
		}
	}

	/**
	 * @return list<array{type: string, value?: mixed, clientId: string, ts: int, eventId: int}>
	 */
	public function recentEventsSince(int $eventId): array {
		$tail = [];
		foreach ($this->eventLog as $event) {
			if ($event['eventId'] > $eventId) {
				$tail[] = $event;
			}
		}
		return $tail;
	}

	/**
	 * @return list<ConnectionInterface>
	 */
	public function activeConnectionsExcept(?string $excludeClientId = null): array {
		$out = [];
		foreach ($this->clients as $client) {
			if ($client->conn === null) {
				continue;
			}
			if ($excludeClientId !== null && $client->clientId === $excludeClientId) {
				continue;
			}
			$out[] = $client->conn;
		}
		return $out;
	}

	/**
	 * Drop tombstoned-and-expired clients. Returns the IDs that were dropped.
	 *
	 * @return list<string>
	 */
	public function pruneExpiredTombstones(int $nowMs): array {
		$dropped = [];
		foreach ($this->clients as $clientId => $client) {
			if ($client->isExpiredTombstone($nowMs)) {
				unset($this->clients[$clientId]);
				$dropped[] = $clientId;
			}
		}
		return $dropped;
	}

	/**
	 * Return clients whose connection has gone idle (no heartbeat within
	 * `idleMs`). Caller is responsible for closing the underlying socket
	 * and removing them.
	 *
	 * @return list<ClientConnection>
	 */
	public function findIdleClients(int $nowMs, int $idleMs): array {
		$idle = [];
		foreach ($this->clients as $client) {
			if ($client->isIdle($nowMs, $idleMs)) {
				$idle[] = $client;
			}
		}
		return $idle;
	}
}
