<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use OCA\PlaybackSync\Db\PlaylistEntry;

/**
 * Builds JSON envelopes for every server→client message in the v2
 * protocol. Every method returns the wire-format string ready for
 * `ConnectionInterface::send()`. Keeping the encoder isolated lets
 * handlers express intent ("send a ROOM_STATE") instead of hand-rolling
 * JSON objects and makes the protocol shape easy to spot in one file.
 *
 * Wire reference: CONTENT_MODEL_PROTOCOL.md (and the protocol spec at
 * `agent-os/specs/2026-05-14-1830-content-model-protocol/plan.md`).
 */
class MessageEncoder {

	public function error(string $code, string $message, int $serverTsMs): string {
		return $this->encode([
			'type' => 'ERROR',
			'code' => $code,
			'message' => $message,
			'serverTs' => $serverTsMs,
		]);
	}

	/**
	 * @param string $nickname The joining client's own server-assigned nickname. Echoed back so the client can render a self-facing "you joined as …" welcome; the client has no other way to learn its nickname.
	 * @param list<PlaylistEntry> $playlist Full playlist; used to derive `playlistVersion`.
	 * @param list<array{type: string, value?: mixed, clientId: string, ts: int, eventId: int}> $recentEvents Tail of playback events the joiner missed on the previous connection.
	 */
	public function roomState(
		string $clientId,
		string $nickname,
		PlaybackState $state,
		?PlaylistEntry $cursorEntry,
		bool $singleMode,
		bool $freeformMode,
		array $playlist,
		int $serverTsMs,
		array $recentEvents = [],
	): string {
		$payload = [
			'type' => 'ROOM_STATE',
			'clientId' => $clientId,
			'nickname' => $nickname,
			'singleMode' => $singleMode,
			'freeformMode' => $freeformMode,
			'cursor' => $cursorEntry !== null ? $this->encodeCursor($cursorEntry) : null,
			'playlistVersion' => self::playlistVersion($playlist),
			'playerState' => $state->playerState,
			'videoPos' => $state->expectedTime($serverTsMs),
			'lastEventId' => $state->eventId,
			'serverTs' => $serverTsMs,
		];
		if ($recentEvents !== []) {
			$payload['recentEvents'] = $recentEvents;
		}
		return $this->encode($payload);
	}

	public function state(PlaybackState $state, int $serverTsMs): string {
		return $this->encode([
			'type' => 'STATE',
			'playerState' => $state->playerState,
			'videoPos' => $state->expectedTime($serverTsMs),
			'eventId' => $state->eventId,
			'serverTs' => $serverTsMs,
		]);
	}

	/**
	 * `CURSOR_CHANGE` is broadcast after a successful cursor move, and
	 * is also unicast to a freshly-joined client whose `currentlyShowing`
	 * mismatches the cursor (steering).
	 */
	public function cursorChange(PlaylistEntry $cursorEntry, int $eventId, int $serverTsMs): string {
		return $this->encode([
			'type' => 'CURSOR_CHANGE',
			'cursor' => $this->encodeCursor($cursorEntry),
			'eventId' => $eventId,
			'serverTs' => $serverTsMs,
		]);
	}

	/**
	 * `PLAYLIST_UPDATE` carries the full post-merge playlist so all
	 * clients converge on the same view. The `playlistVersion` lets
	 * recipients detect whether they already hold this snapshot.
	 *
	 * @param list<PlaylistEntry> $entries
	 */
	public function playlistUpdate(array $entries, int $serverTsMs): string {
		return $this->encode([
			'type' => 'PLAYLIST_UPDATE',
			'entries' => array_map(fn (PlaylistEntry $e) => $this->encodePlaylistEntry($e), $entries),
			'playlistVersion' => self::playlistVersion($entries),
			'serverTs' => $serverTsMs,
		]);
	}

	/**
	 * `NOTICE` is a display-only, actor-attributed frame broadcast to a
	 * room's peers so their clients can surface "who did what" toasts
	 * (e.g. "SwiftFox42 paused", "SwiftFox42 skipped to 12:34"). It is
	 * deliberately decoupled from the authoritative `STATE` / `CURSOR_CHANGE`
	 * frames, which stay identity-free — `NOTICE` is the one server→client
	 * frame that carries a nickname.
	 *
	 * The inner discriminant is `event` (not `type`) so it doesn't collide
	 * with the frame's own `type: 'NOTICE'`. The field vocabulary mirrors the
	 * event-log envelope built in `RoomRuntime::pushEvent`.
	 *
	 * @param string $event play|pause|seek|cursor_change|client_joined|client_left.
	 * @param string $category playback|presence — the envelope class the event belongs to.
	 * @param string $actor client|owner|system — origin class of the action.
	 * @param string|null $actorId Actor nickname (for clients), owner userId (for owner), or null (system).
	 * @param array<string, mixed>|null $data Event-specific payload: seek `{value}`, cursor_change `{videoRef}`, client_left `{nickname, reason}`.
	 */
	public function notice(string $event, string $category, string $actor, ?string $actorId, ?array $data, int $serverTsMs): string {
		return $this->encode([
			'type' => 'NOTICE',
			'event' => $event,
			'category' => $category,
			'actor' => $actor,
			'actorId' => $actorId,
			'data' => $data,
			'serverTs' => $serverTsMs,
		]);
	}

	public function syncAdjust(int $serverTsMs, float $targetPos, string $mode): string {
		return $this->encode([
			'type' => 'SYNC_ADJUST',
			'serverTime' => $serverTsMs,
			'targetPos' => $targetPos,
			'mode' => $mode,
		]);
	}

	public function clockPong(float $clientSendTime, int $serverRecvTimeMs, int $serverSendTimeMs): string {
		return $this->encode([
			'type' => 'CLOCK_PONG',
			'clientSendTime' => $clientSendTime,
			'serverRecvTime' => $serverRecvTimeMs,
			'serverSendTime' => $serverSendTimeMs,
		]);
	}

	/**
	 * Render a `PlaylistEntry` onto the wire shape consumed by clients.
	 *
	 * @return array{entryId: string, position: int, providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int, source: string, addedAt: int, lastSeenAt: int}
	 */
	private function encodePlaylistEntry(PlaylistEntry $entry): array {
		return [
			'entryId' => $entry->entryId,
			'position' => $entry->position,
			'providerId' => $entry->providerId,
			'videoId' => $entry->videoId,
			'pageUrl' => $entry->pageUrl,
			'label' => $entry->label,
			'episodeNumber' => $entry->episodeNumber,
			'seasonNumber' => $entry->seasonNumber,
			'source' => $entry->source,
			'addedAt' => $entry->addedAt,
			'lastSeenAt' => $entry->lastSeenAt,
		];
	}

	/**
	 * Cursor projection carried on `CURSOR_CHANGE` and `ROOM_STATE`. Just
	 * enough for the client to navigate the tab and label the room state.
	 *
	 * @return array{entryId: string, providerId: string, videoId: string, pageUrl: string, label: ?string}
	 */
	private function encodeCursor(PlaylistEntry $cursorEntry): array {
		return [
			'entryId' => $cursorEntry->entryId,
			'providerId' => $cursorEntry->providerId,
			'videoId' => $cursorEntry->videoId,
			'pageUrl' => $cursorEntry->pageUrl,
			'label' => $cursorEntry->label,
		];
	}

	/**
	 * Stable fingerprint over the playlist's `(entryId, position, source,
	 * lastSeenAt)` tuples. Clients hold the previous `playlistVersion` and
	 * compare it on `ROOM_STATE` / `PLAYLIST_UPDATE` to skip redundant
	 * reconciles. SHA-256 keeps collision risk negligible.
	 *
	 * @param list<PlaylistEntry> $entries
	 */
	public static function playlistVersion(array $entries): string {
		if ($entries === []) {
			return 'v0';
		}
		$parts = [];
		foreach ($entries as $entry) {
			$parts[] = $entry->entryId . ':' . $entry->position . ':' . $entry->source . ':' . $entry->lastSeenAt;
		}
		return 'v' . substr(hash('sha256', implode('|', $parts)), 0, 16);
	}

	private function encode(array $payload): string {
		return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
	}
}
