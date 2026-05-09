<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

/**
 * In-memory map of `roomUuid → RoomRuntime`. The first JOIN to a previously
 * unseen room creates the runtime here; subsequent connections reuse it.
 *
 * Identity (uuid, password, expiry) lives in the database and is fetched on
 * each JOIN — this registry only owns the live state (clients, playback,
 * event log) that has no reason to be persisted.
 */
class RoomRegistry {
	/** @var array<string, RoomRuntime> */
	private array $rooms = [];

	public function __construct(
		private readonly int $eventLogSize,
	) {
	}

	public function getOrCreate(string $uuid, int $expiresAtMs): RoomRuntime {
		if (!isset($this->rooms[$uuid])) {
			$this->rooms[$uuid] = new RoomRuntime($uuid, $expiresAtMs, $this->eventLogSize);
		} else {
			// Refresh expiry — the DB row's expiresAt is the source of truth.
			$this->rooms[$uuid]->expiresAtMs = $expiresAtMs;
		}
		return $this->rooms[$uuid];
	}

	public function find(string $uuid): ?RoomRuntime {
		return $this->rooms[$uuid] ?? null;
	}

	public function remove(string $uuid): void {
		unset($this->rooms[$uuid]);
	}

	/**
	 * @return array<string, RoomRuntime>
	 */
	public function all(): array {
		return $this->rooms;
	}
}
