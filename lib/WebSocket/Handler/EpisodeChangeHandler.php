<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use Ratchet\ConnectionInterface;

/**
 * Handles `EPISODE_CHANGE_REQUEST`: hard-resets the room's playback state
 * (paused at zero), updates the in-memory cursor, and broadcasts
 * `EPISODE_CHANGE` to every connected client.
 *
 * Transitional shim: the handler synthesizes a `PlaylistEntry` from the
 * wire payload and overwrites the runtime's in-memory cursor — it does
 * NOT persist the change yet. Persistence through the wire path (using
 * `PlaylistService::autoAppend` / `setCursor` under the right per-mode
 * rules) lands in the protocol spec.
 *
 * Rate-limited the same way as `EVENT` to avoid abuse.
 */
class EpisodeChangeHandler {

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param array{episodeId: string, providerId: string, pageUrl: string, clientTs: int} $payload
	 */
	public function handle(
		ConnectionInterface $conn,
		ConnectionContext $ctx,
		array $payload,
		int $nowMs,
	): void {
		if (!$ctx->joined || $ctx->clientId === null) {
			throw new MessageException('NOT_JOINED', 'EPISODE_CHANGE_REQUEST requires a prior JOIN', closeAfter: true);
		}

		$runtime = $this->registry->find($ctx->roomUuid);
		if ($runtime === null) {
			throw new MessageException('ROOM_NOT_FOUND', 'Room is no longer active', closeAfter: true);
		}
		$client = $runtime->getClient($ctx->clientId);
		if ($client === null || $client->conn === null) {
			throw new MessageException('NOT_JOINED', 'Client is not in the room', closeAfter: true);
		}

		if (!$client->rateLimiter->tryConsume($nowMs)) {
			throw new MessageException('RATE_LIMITED', 'Too many control events; slow down');
		}

		$nowSec = (int)floor($nowMs / 1000);
		$entry = new PlaylistEntry(
			entryId: PlaylistEntry::generateEntryId(),
			position: 0,
			providerId: $payload['providerId'],
			videoId: $payload['episodeId'],
			pageUrl: $payload['pageUrl'],
			label: null,
			episodeNumber: null,
			seasonNumber: null,
			source: PlaylistEntry::SOURCE_AUTO_APPENDED,
			addedBy: $client->clientId,
			addedAt: $nowSec,
			lastSeenAt: $nowSec,
		);

		// In-memory only: replace any prior transient cursor with this one.
		// The persisted state (`Room::playlist` / `Room::cursorEntryId`) is
		// untouched — the protocol spec wires the proper persistence path.
		$runtime->playlist = $this->upsertCursorEntry($runtime->playlist, $entry);
		$runtime->cursorEntryId = $entry->entryId;

		$eventId = $runtime->state->applyEpisodeReset($nowMs);
		$runtime->pushEvent(
			'episode_change',
			MessageEncoder::deriveContentKey($entry->providerId, $entry->videoId, $entry->pageUrl),
			$client->nickname,
			$nowMs,
			$eventId,
		);
		$client->lastEventId = $eventId;
		$client->markSeen($nowMs);

		$frame = $this->encoder->episodeChange($eventId, $entry, $nowMs);
		foreach ($runtime->clients() as $peer) {
			if ($peer->conn !== null) {
				$peer->conn->send($frame);
			}
		}
	}

	/**
	 * Add or replace a transient cursor entry inside the runtime's
	 * in-memory playlist. Entries with the same `(providerId, videoId)`
	 * are replaced rather than duplicated so repeated EPISODE_CHANGE
	 * round-trips don't accumulate stale records.
	 *
	 * @param list<PlaylistEntry> $playlist
	 * @return list<PlaylistEntry>
	 */
	private function upsertCursorEntry(array $playlist, PlaylistEntry $entry): array {
		$key = strtolower($entry->providerId) . '|' . strtolower($entry->videoId);
		$kept = [];
		foreach ($playlist as $existing) {
			$existingKey = strtolower($existing->providerId) . '|' . strtolower($existing->videoId);
			if ($existingKey === $key) {
				continue;
			}
			$kept[] = $existing;
		}
		$kept[] = $entry;
		return $kept;
	}
}
