<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\RoomRuntime;
use OCP\AppFramework\Db\DoesNotExistException;

/**
 * Handles `POST /admin/rooms/{uuid}/broadcast` from the loopback admin
 * server. Triggered by Nextcloud-side HTTP controllers after a DB write
 * (playlist add/remove, cursor set via dashboard, toggle update) so the
 * daemon's runtime cache stays in sync with the database and the right
 * wire frame fans out to every connected viewer.
 *
 * Kinds correspond to the wire frame to emit:
 *
 * - `cursor_change` → re-hydrate runtime, broadcast `CURSOR_CHANGE`,
 *   log a `cursor_change` envelope. Used after `POST /rooms/{uuid}/cursor`.
 * - `playlist_update` → re-hydrate runtime, broadcast `PLAYLIST_UPDATE`
 *   with the full post-state playlist, log a `playlist_update`
 *   envelope. Used after curated add/remove.
 * - `room_state` → re-hydrate runtime (toggles only, no fanout frame).
 *   Subsequent reconnects pick up the new toggles via JOIN. Used after
 *   `POST /rooms/{uuid}/settings`.
 *
 * Returns one of the `RESULT_*` constants; the HTTP server maps those
 * onto status codes.
 */
class RoomBroadcastController {

	public const RESULT_BROADCAST = 'broadcast';
	public const RESULT_ROOM_NOT_FOUND = 'room_not_found';
	public const RESULT_NO_RUNTIME = 'no_runtime';
	public const RESULT_INVALID_KIND = 'invalid_kind';

	public const KIND_CURSOR_CHANGE = 'cursor_change';
	public const KIND_PLAYLIST_UPDATE = 'playlist_update';
	public const KIND_ROOM_STATE = 'room_state';

	public function __construct(
		private readonly RoomMapper $mapper,
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param string|null $ownerUserId Nextcloud userId that triggered the broadcast (room owner). Forwarded to the event log envelope.
	 */
	public function broadcast(string $roomUuid, string $kind, int $nowMs, ?string $ownerUserId): string {
		$runtime = $this->registry->find($roomUuid);
		if ($runtime === null) {
			return self::RESULT_NO_RUNTIME;
		}

		try {
			$room = $this->mapper->findByUuid($roomUuid);
		} catch (DoesNotExistException) {
			return self::RESULT_ROOM_NOT_FOUND;
		}

		// The DB is the source of truth — refresh the runtime cache
		// before deciding what to broadcast so the wire frame matches
		// what's persisted.
		$runtime->refreshPlaylistFromDb($room);

		switch ($kind) {
			case self::KIND_CURSOR_CHANGE:
				return $this->broadcastCursorChange($runtime, $nowMs, $ownerUserId);

			case self::KIND_PLAYLIST_UPDATE:
				return $this->broadcastPlaylistUpdate($runtime, $nowMs, $ownerUserId);

			case self::KIND_ROOM_STATE:
				// Settings change: runtime is now refreshed. No frame is
				// pushed; on the next playback or cursor event clients
				// receive the new toggles via ROOM_STATE or the
				// per-mode reaction. This is intentional — toggle flips
				// rarely happen during active playback.
				return self::RESULT_BROADCAST;

			default:
				return self::RESULT_INVALID_KIND;
		}
	}

	private function broadcastCursorChange(RoomRuntime $runtime, int $nowMs, ?string $ownerUserId): string {
		$cursor = $runtime->cursorEntry();
		if ($cursor === null) {
			// Nothing to point at; treat as a no-op rather than an error.
			// This can happen if the controller raced a delete of the
			// only entry — predictable behaviour beats a 5xx.
			return self::RESULT_BROADCAST;
		}

		$eventId = $runtime->state->applyEpisodeReset($nowMs);
		$frame = $this->encoder->cursorChange($cursor, $eventId, $nowMs);
		foreach ($runtime->activeConnectionsExcept(null) as $peerConn) {
			$peerConn->send($frame);
		}

		$runtime->pushEnvelope([
			'ts' => $nowMs,
			'type' => 'cursor_change',
			'category' => 'playback',
			'actor' => 'owner',
			'actorId' => $ownerUserId,
			'data' => [
				'to' => $cursor->entryId,
				'videoRef' => [
					'providerId' => $cursor->providerId,
					'videoId' => $cursor->videoId,
					'pageUrl' => $cursor->pageUrl,
				],
			],
			'playbackEventId' => $eventId,
		]);
		return self::RESULT_BROADCAST;
	}

	private function broadcastPlaylistUpdate(RoomRuntime $runtime, int $nowMs, ?string $ownerUserId): string {
		$frame = $this->encoder->playlistUpdate($runtime->playlist, $nowMs);
		foreach ($runtime->activeConnectionsExcept(null) as $peerConn) {
			$peerConn->send($frame);
		}

		$runtime->pushEnvelope([
			'ts' => $nowMs,
			'type' => 'playlist_update',
			'category' => 'lifecycle',
			'actor' => 'owner',
			'actorId' => $ownerUserId,
			'data' => [
				'entryCount' => count($runtime->playlist),
			],
		]);
		return self::RESULT_BROADCAST;
	}
}
