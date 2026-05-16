<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\Exceptions\PlaylistCapExceededException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistLockedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\PlaylistService;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\RoomRuntime;
use Ratchet\ConnectionInterface;

/**
 * Handles `PLAYLIST_UPDATE` from clients — typically scrape
 * contributions from the extension on a series-aware page. Delegates
 * the merge to `PlaylistService` and broadcasts the post-merge
 * playlist as `PLAYLIST_UPDATE` so every connected client converges
 * on the same view.
 *
 * Rate-limited via a dedicated per-connection bucket (separate from
 * the playback-event bucket) so a scrape on JOIN doesn't eat into the
 * EVENT/CURSOR_CHANGE_REQUEST budget.
 */
class PlaylistUpdateHandler {

	public function __construct(
		private readonly PlaylistService $playlistService,
		private readonly RoomMapper $roomMapper,
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param array{
	 *   entries: list<array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int, source: ?string}>,
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
			throw new MessageException('NOT_JOINED', 'PLAYLIST_UPDATE requires a prior JOIN', closeAfter: true);
		}

		$runtime = $this->registry->find($ctx->roomUuid);
		if ($runtime === null) {
			throw new MessageException('ROOM_NOT_FOUND', 'Room is no longer active', closeAfter: true);
		}
		$client = $runtime->getClient($ctx->clientId);
		if ($client === null || $client->conn === null) {
			throw new MessageException('NOT_JOINED', 'Client is not in the room', closeAfter: true);
		}

		if (!$client->playlistRateLimiter->tryConsume($nowMs)) {
			throw new MessageException('RATE_LIMITED', 'Too many playlist updates; slow down');
		}

		try {
			$merged = $this->playlistService->merge(
				$runtime->uuid,
				$payload['entries'],
				PlaylistEntry::SOURCE_SCRAPED,
				$client->clientId,
			);
		} catch (PlaylistLockedException $e) {
			throw new MessageException('single_mode_locked', $e->getMessage());
		} catch (PlaylistCapExceededException $e) {
			throw new MessageException($e->capCode, $e->getMessage());
		} catch (RoomNotFoundException) {
			throw new MessageException('ROOM_NOT_FOUND', 'Room is no longer active', closeAfter: true);
		}

		$this->refreshRuntime($runtime);
		$client->markSeen($nowMs);

		$frame = $this->encoder->playlistUpdate($merged, $nowMs);
		foreach ($runtime->activeConnectionsExcept(null) as $peerConn) {
			$peerConn->send($frame);
		}

		$runtime->pushEnvelope([
			'ts' => $nowMs,
			'type' => 'playlist_update',
			'category' => 'lifecycle',
			'actor' => 'client',
			'actorId' => $client->nickname,
			'data' => [
				'addedCount' => count($payload['entries']),
				'source' => PlaylistEntry::SOURCE_SCRAPED,
			],
		]);
	}

	private function refreshRuntime(RoomRuntime $runtime): void {
		$room = $this->roomMapper->findByUuid($runtime->uuid);
		$runtime->refreshPlaylistFromDb($room);
	}
}
