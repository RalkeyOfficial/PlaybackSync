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
 *
 * Also owns the process-wide monotonic event id, a per-room subscriber map
 * for SSE consumers, plus a separate global ring + subscriber map for the
 * cross-room admin feed. Subscribers are invoked synchronously when an
 * envelope is published, so they live in the same single-threaded React
 * event loop as everything else in the daemon — no locking.
 */
class RoomRegistry {
	/** @var array<string, RoomRuntime> */
	private array $rooms = [];

	private int $nextEventLogId = 0;

	/** @var array<string, array<int, callable(array): void>> */
	private array $roomSubscribers = [];

	/** @var array<int, callable(array): void> */
	private array $globalSubscribers = [];

	/**
	 * Cross-room ring of envelopes that have no live `RoomRuntime` (lifecycle
	 * events fired before a runtime exists, admin actions with no roomUuid,
	 * etc). Room-scoped envelopes are NOT duplicated here — `mergedEventsSince`
	 * walks the per-room rings instead, which keeps each event in exactly one
	 * place and avoids unbounded duplication.
	 *
	 * @var list<array<string, mixed>>
	 */
	private array $globalEventLog = [];

	public function __construct(
		private readonly int $eventLogSize,
	) {
	}

	public function getOrCreate(string $uuid, int $expiresAtMs): RoomRuntime {
		if (!isset($this->rooms[$uuid])) {
			$this->rooms[$uuid] = new RoomRuntime($uuid, $expiresAtMs, $this->eventLogSize, $this);
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
		// Subscribers keep their references; they'll just stop receiving events.
		// Streaming connections clean themselves up on socket close.
	}

	/**
	 * @return array<string, RoomRuntime>
	 */
	public function all(): array {
		return $this->rooms;
	}

	/**
	 * Allocate a fresh, process-wide monotonic event id. Used by `RoomRuntime`
	 * when it appends to its ring; the SSE wire uses this as `Last-Event-ID`.
	 *
	 * Counter resets when the daemon restarts. The `meta` SSE record carries
	 * `daemonStartedAtMs` so a reconnecting client whose `Last-Event-ID` is
	 * higher than the current counter can detect the reset.
	 */
	public function allocateEventId(): int {
		return ++$this->nextEventLogId;
	}

	/**
	 * Subscribe to envelopes pushed into the given room's runtime. Returns
	 * an unsubscribe closure — call it on connection close to detach.
	 *
	 * @param callable(array): void $emit Called once per envelope.
	 * @return callable(): void
	 */
	public function subscribeRoom(string $uuid, callable $emit): callable {
		// PHP closures don't have a stable identity, so allocate a numeric slot.
		static $nextSlot = 0;
		$slot = ++$nextSlot;
		$this->roomSubscribers[$uuid][$slot] = $emit;

		return function () use ($uuid, $slot): void {
			unset($this->roomSubscribers[$uuid][$slot]);
			if (($this->roomSubscribers[$uuid] ?? []) === []) {
				unset($this->roomSubscribers[$uuid]);
			}
		};
	}

	/**
	 * Subscribe to every envelope published anywhere in the daemon — per-room
	 * pushes (`RoomRuntime::pushEnvelope` / `pushEvent`) and direct global
	 * appends (`appendGlobalEvent`) both fan out here. Returns an unsubscribe
	 * closure.
	 *
	 * @param callable(array): void $emit Called once per envelope.
	 * @return callable(): void
	 */
	public function subscribeGlobal(callable $emit): callable {
		static $nextSlot = 0;
		$slot = ++$nextSlot;
		$this->globalSubscribers[$slot] = $emit;

		return function () use ($slot): void {
			unset($this->globalSubscribers[$slot]);
		};
	}

	/**
	 * Internal — called by `RoomRuntime::pushEnvelope`. Fans an envelope out to
	 * every subscriber registered for the room AND every global subscriber. A
	 * subscriber that throws is isolated: its exception is caught and dropped
	 * so one bad consumer cannot stall the daemon loop or break other
	 * subscribers.
	 */
	public function publishRoomEvent(string $uuid, array $envelope): void {
		foreach ($this->roomSubscribers[$uuid] ?? [] as $emit) {
			$this->invokeSubscriber($emit, $envelope);
		}
		foreach ($this->globalSubscribers as $emit) {
			$this->invokeSubscriber($emit, $envelope);
		}
	}

	/**
	 * Append a global-scoped envelope (lifecycle / admin events that have no
	 * live `RoomRuntime`) to the cross-room ring. Allocates the SSE id, sets
	 * `ts` defensively if missing, evicts the oldest entry once the ring is
	 * full, and fans out to global + matching-room subscribers so a per-room
	 * viewer still sees lifecycle events scoped to their room.
	 *
	 * Returns the assigned envelope id so the ingest endpoint can echo it
	 * back to the caller.
	 *
	 * @param array<string, mixed> $envelope Pre-shaped envelope sans `id`.
	 */
	public function appendGlobalEvent(array $envelope): int {
		$envelope['id'] = $this->allocateEventId();
		if (!isset($envelope['ts'])) {
			$envelope['ts'] = (int)(microtime(true) * 1000);
		}
		$this->globalEventLog[] = $envelope;
		if (count($this->globalEventLog) > $this->eventLogSize) {
			array_shift($this->globalEventLog);
		}

		$roomUuid = $envelope['roomUuid'] ?? null;
		if (is_string($roomUuid) && isset($this->roomSubscribers[$roomUuid])) {
			foreach ($this->roomSubscribers[$roomUuid] as $emit) {
				$this->invokeSubscriber($emit, $envelope);
			}
		}
		foreach ($this->globalSubscribers as $emit) {
			$this->invokeSubscriber($emit, $envelope);
		}
		return $envelope['id'];
	}

	/**
	 * Backfill source for the global SSE stream. Returns a chronological
	 * merge of every live `RoomRuntime`'s envelopes plus the cross-room
	 * `$globalEventLog`, filtered to `id > $sinceId` and sliced to `$limit`
	 * (most-recent-first slice, returned in ascending-id order so consumers
	 * can append directly).
	 *
	 * @return list<array<string, mixed>>
	 */
	public function mergedEventsSince(int $sinceId, int $limit = 500): array {
		$merged = $this->globalEventLog;
		foreach ($this->rooms as $runtime) {
			foreach ($runtime->envelopesSince(0) as $env) {
				$merged[] = $env;
			}
		}
		$filtered = [];
		foreach ($merged as $env) {
			if (($env['id'] ?? 0) > $sinceId) {
				$filtered[] = $env;
			}
		}
		usort($filtered, static fn (array $a, array $b): int => ($a['id'] ?? 0) <=> ($b['id'] ?? 0));
		if (count($filtered) > $limit) {
			$filtered = array_slice($filtered, -$limit);
		}
		return $filtered;
	}

	/**
	 * Read-only snapshot of the cross-room ring. Exposed for tests; callers
	 * in the daemon path should go through `mergedEventsSince`.
	 *
	 * @return list<array<string, mixed>>
	 */
	public function globalEventLog(): array {
		return $this->globalEventLog;
	}

	private function invokeSubscriber(callable $emit, array $envelope): void {
		try {
			$emit($envelope);
		} catch (\Throwable) {
			// Swallow — a wedged subscriber can't take down the daemon.
		}
	}
}
