<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\CursorService;
use OCA\PlaybackSync\Service\Dto\CursorTarget;
use OCA\PlaybackSync\Service\Exceptions\CursorEntryNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\NotInPlaylistException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistCapExceededException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistLockedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\RoomRuntime;
use Ratchet\ConnectionInterface;

/**
 * Handles `CURSOR_CHANGE_REQUEST`. Delegates the per-mode reaction
 * matrix to `CursorService`, then broadcasts `PLAYLIST_UPDATE` (when
 * freeform auto-append created a new entry) followed by `CURSOR_CHANGE`
 * to every client in the room. Also resets the room's playback state
 * (paused at zero) so the new cursor starts fresh.
 *
 * Rate-limited via the per-connection events bucket — same budget that
 * gates `EVENT` traffic — because semantically a cursor change is a
 * playback-control event.
 */
class CursorChangeHandler {

	public function __construct(
		private readonly CursorService $cursorService,
		private readonly RoomMapper $roomMapper,
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param array{
	 *   targetEntryId: ?string,
	 *   target: ?array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int},
	 *   clientTs: int
	 * } $payload
	 */
	public function handle(
		ConnectionInterface $conn,
		ConnectionContext $ctx,
		array $payload,
		int $nowMs,
	): void {
		if (!$ctx->joined || $ctx->clientId === null) {
			throw new MessageException('NOT_JOINED', 'CURSOR_CHANGE_REQUEST requires a prior JOIN', closeAfter: true);
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

		$target = $payload['targetEntryId'] !== null
			? CursorTarget::byEntryId($payload['targetEntryId'])
			: CursorTarget::byVideoRef($payload['target'] ?? throw new MessageException('INVALID_MESSAGE', 'CURSOR_CHANGE_REQUEST.target missing'));

		try {
			$outcome = $this->cursorService->requestChange($runtime->uuid, $target, $client->clientId);
		} catch (PlaylistLockedException $e) {
			throw new MessageException('single_mode_locked', $e->getMessage());
		} catch (NotInPlaylistException $e) {
			throw new MessageException('not_in_playlist', $e->getMessage());
		} catch (CursorEntryNotFoundException $e) {
			throw new MessageException('not_in_playlist', $e->getMessage());
		} catch (PlaylistCapExceededException $e) {
			throw new MessageException('playlist_cap_exceeded', $e->getMessage());
		} catch (RoomNotFoundException) {
			throw new MessageException('ROOM_NOT_FOUND', 'Room is no longer active', closeAfter: true);
		}

		// Refresh runtime cache from the freshly-committed DB state.
		$this->refreshRuntime($runtime);

		// Single transactional reset of playback state — the new cursor
		// starts paused at zero, mirroring the legacy episode-change
		// behaviour clients already understand.
		$eventId = $runtime->state->applyEpisodeReset($nowMs);
		$client->lastEventId = $eventId;
		$client->markSeen($nowMs);

		// 1. Broadcast PLAYLIST_UPDATE first if a new entry was auto-appended.
		if ($outcome->appendedEntry !== null) {
			$playlistFrame = $this->encoder->playlistUpdate($outcome->playlist, $nowMs);
			foreach ($runtime->activeConnectionsExcept(null) as $peerConn) {
				$peerConn->send($playlistFrame);
			}
			$runtime->pushEnvelope([
				'ts' => $nowMs,
				'type' => 'playlist_update',
				'category' => 'lifecycle',
				'actor' => 'client',
				'actorId' => $client->nickname,
				'data' => [
					'added' => [$outcome->appendedEntry->toArray()],
					'source' => $outcome->appendedEntry->source,
				],
			]);
		}

		// 2. Broadcast CURSOR_CHANGE.
		$cursorFrame = $this->encoder->cursorChange($outcome->cursor, $eventId, $nowMs);
		foreach ($runtime->activeConnectionsExcept(null) as $peerConn) {
			$peerConn->send($cursorFrame);
		}

		// 3. Log the cursor_change envelope.
		$runtime->pushEvent(
			'cursor_change',
			[
				'from' => $outcome->previousCursorEntryId,
				'to' => $outcome->cursor->entryId,
				'videoRef' => [
					'providerId' => $outcome->cursor->providerId,
					'videoId' => $outcome->cursor->videoId,
					'pageUrl' => $outcome->cursor->pageUrl,
				],
			],
			$client->nickname,
			$nowMs,
			$eventId,
		);
	}

	private function refreshRuntime(RoomRuntime $runtime): void {
		$room = $this->roomMapper->findByUuid($runtime->uuid);
		$runtime->refreshPlaylistFromDb($room);
	}
}
