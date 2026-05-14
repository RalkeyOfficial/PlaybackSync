<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\Room;
use Ratchet\ConnectionInterface;

/**
 * Live state for one room: playback, members, recent events. Pure value
 * object — no I/O — so it's trivial to unit-test the lifecycle without
 * spinning up a network stack.
 *
 * The event log is a fixed-size ring buffer of rich envelopes (see
 * `pushEnvelope`). Each entry carries a process-wide `id` (used as the SSE
 * `Last-Event-ID`) and, for playback events, the per-room `playbackEventId`
 * that the reconnect-replay path uses to find the tail a client missed.
 */
class RoomRuntime {
	/** @var array<string, ClientConnection> */
	private array $clients = [];

	/**
	 * @var list<array{
	 *   id: int,
	 *   ts: int,
	 *   type: string,
	 *   category: string,
	 *   actor: string,
	 *   actorId: ?string,
	 *   roomUuid: string,
	 *   data: ?array<string, mixed>,
	 *   playbackEventId?: int
	 * }>
	 */
	private array $eventLog = [];

	/**
	 * Per-clientId reconnect block. After a kick, the same `clientId` is
	 * forbidden from rejoining until the recorded timestamp passes. This
	 * prevents an immediate re-flap; it's anti-flap, not a security ban —
	 * a kicked client can still rejoin with a fresh `clientId`.
	 *
	 * @var array<string, int>
	 */
	private array $kickBlocks = [];

	/**
	 * In-memory cache of the persisted playlist, refreshed on JOIN and
	 * after every successful service-layer write. The DB is the source of
	 * truth; this cache exists so handlers can read the cursor entry and
	 * the playlist without a per-message DB round-trip.
	 *
	 * @var list<PlaylistEntry>
	 */
	public array $playlist = [];

	public ?string $cursorEntryId = null;

	public PlaybackState $state;

	public function __construct(
		public readonly string $uuid,
		public int $expiresAtMs,
		public readonly int $eventLogSize = 200,
		private readonly ?RoomRegistry $registry = null,
	) {
		$this->state = new PlaybackState();
	}

	public function isExpired(int $nowMs): bool {
		return $this->expiresAtMs <= $nowMs;
	}

	/**
	 * Replace this runtime's playlist + cursor cache with the persisted
	 * state on the supplied Room entity. Called on first JOIN (when the
	 * runtime is first hydrated) and after every service-layer write
	 * that mutates the playlist or the cursor.
	 */
	public function refreshPlaylistFromDb(Room $room): void {
		$this->playlist = $room->getPlaylistEntries();
		$this->cursorEntryId = $room->getCursorEntryId();
	}

	/**
	 * Return the playlist entry currently referenced by `cursorEntryId`,
	 * or null if the cursor is unset or stale (the referenced entry has
	 * been removed). Linear scan — fine at the 1000-entry per-room cap.
	 */
	public function cursorEntry(): ?PlaylistEntry {
		if ($this->cursorEntryId === null) {
			return null;
		}
		foreach ($this->playlist as $entry) {
			if ($entry->entryId === $this->cursorEntryId) {
				return $entry;
			}
		}
		return null;
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
	 * Push a playback event (`play`, `pause`, `seek`, `reset`) into the ring
	 * and fan it out to subscribers. Preserves the legacy semantics of the
	 * old `pushEvent(type, value, actorId, ts, eventId)` signature for callers
	 * that already drive `PlaybackState::applyPlay`/etc.
	 *
	 * `eventId` is the playback state version (per-room); the SSE wire id is
	 * allocated separately from the registry.
	 *
	 * @param string $type    play|pause|seek|reset|episode_change (use the strings already in use).
	 * @param mixed  $value   Type-specific scalar (e.g. seek videoPos). Stored under `data.value`.
	 * @param string $actorId Client nickname, or `'admin'` sentinel for owner-via-dashboard.
	 */
	public function pushEvent(string $type, mixed $value, string $actorId, int $tsMs, int $eventId): void {
		// `'admin'` is a legacy sentinel meaning "the room owner acting via
		// the dashboard loopback" — it is NOT a Nextcloud administrator. Map
		// it to `actor: 'owner'` and drop the sentinel from `actorId` so the
		// UI can fall back to a clean "owner" label instead of literally
		// rendering the string "admin".
		$isOwnerLoopback = $actorId === 'admin';
		$envelope = [
			'id' => $this->registry?->allocateEventId() ?? $eventId,
			'ts' => $tsMs,
			'type' => $type,
			'category' => 'playback',
			'actor' => $isOwnerLoopback ? 'owner' : 'client',
			'actorId' => $isOwnerLoopback ? null : $actorId,
			'roomUuid' => $this->uuid,
			'data' => $value === null ? null : ['value' => $value],
			'playbackEventId' => $eventId,
		];
		$this->appendEnvelope($envelope);
	}

	/**
	 * Push a fully-formed envelope (presence, lifecycle, admin, or an owner-
	 * originated playback command) into the ring. Caller is responsible for
	 * the envelope shape — see the spec at
	 * `agent-os/specs/2026-05-12-2038-event-log-sse/plan.md`.
	 *
	 * For playback envelopes, the optional `playbackEventId` field is preserved
	 * at top level so `recentEventsSince` can keep feeding the legacy client
	 * reconnect-replay tail.
	 *
	 * @param array{
	 *   ts: int,
	 *   type: string,
	 *   category: string,
	 *   actor: string,
	 *   actorId: ?string,
	 *   data?: ?array<string, mixed>,
	 *   playbackEventId?: int
	 * } $envelope Caller-supplied; the runtime fills in `id` and `roomUuid`.
	 */
	public function pushEnvelope(array $envelope): void {
		$full = $envelope + ['data' => null];
		$full['id'] = $this->registry?->allocateEventId() ?? 0;
		$full['roomUuid'] = $this->uuid;
		$this->appendEnvelope($full);
	}

	/**
	 * Replay tail for client reconnects. Returns playback events with
	 * `playbackEventId > $clientLastEventId`, mapped to the legacy 5-tuple
	 * shape consumed by `MessageEncoder::roomState`.
	 *
	 * Presence/lifecycle envelopes are intentionally excluded — clients only
	 * know how to apply playback events on reconnect.
	 *
	 * @return list<array{type: string, value: mixed, clientId: string, ts: int, eventId: int}>
	 */
	public function recentEventsSince(int $clientLastEventId): array {
		$tail = [];
		foreach ($this->eventLog as $env) {
			if ($env['category'] !== 'playback') {
				continue;
			}
			$pid = $env['playbackEventId'] ?? null;
			if ($pid === null || $pid <= $clientLastEventId) {
				continue;
			}
			$tail[] = [
				'type' => $env['type'],
				'value' => $env['data']['value'] ?? null,
				'clientId' => $env['actorId'] ?? '',
				'ts' => $env['ts'],
				'eventId' => $pid,
			];
		}
		return $tail;
	}

	/**
	 * SSE backfill: return every envelope currently in the ring whose `id` is
	 * greater than `$sinceId`. Returns the full envelope shape (no mapping).
	 *
	 * @return list<array<string, mixed>>
	 */
	public function envelopesSince(int $sinceId): array {
		$out = [];
		foreach ($this->eventLog as $env) {
			if (($env['id'] ?? 0) > $sinceId) {
				$out[] = $env;
			}
		}
		return $out;
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
	 * Drop tombstoned-and-expired clients. Returns the removed connections.
	 *
	 * @return list<ClientConnection>
	 */
	public function pruneExpiredTombstones(int $nowMs): array {
		$dropped = [];
		foreach ($this->clients as $clientId => $client) {
			if ($client->isExpiredTombstone($nowMs)) {
				unset($this->clients[$clientId]);
				$dropped[] = $client;
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

	/**
	 * Forcibly disconnect a client by id. Sends a final `KICKED` error frame
	 * (best-effort), closes the underlying socket, removes the client, and
	 * records a reconnect block until `nowMs + blockMs` so the same id can't
	 * immediately rejoin.
	 *
	 * Returns true when a connected client matched and was kicked; false
	 * when no such client exists in this runtime.
	 */
	public function kickClient(string $clientId, MessageEncoder $encoder, int $blockMs, int $nowMs): bool {
		$client = $this->clients[$clientId] ?? null;
		if ($client === null) {
			return false;
		}
		if ($client->conn !== null) {
			$client->conn->send($encoder->error('KICKED', 'Disconnected by room owner', $nowMs));
			$client->conn->close();
		}
		unset($this->clients[$clientId]);
		$this->kickBlocks[$clientId] = $nowMs + $blockMs;
		return true;
	}

	public function isClientBlocked(string $clientId, int $nowMs): bool {
		$until = $this->kickBlocks[$clientId] ?? null;
		if ($until === null) {
			return false;
		}
		if ($until <= $nowMs) {
			unset($this->kickBlocks[$clientId]);
			return false;
		}
		return true;
	}

	public function pruneExpiredKickBlocks(int $nowMs): void {
		foreach ($this->kickBlocks as $clientId => $until) {
			if ($until <= $nowMs) {
				unset($this->kickBlocks[$clientId]);
			}
		}
	}

	private function appendEnvelope(array $envelope): void {
		$this->eventLog[] = $envelope;
		if (count($this->eventLog) > $this->eventLogSize) {
			array_shift($this->eventLog);
		}
		$this->registry?->publishRoomEvent($this->uuid, $envelope);
	}
}
