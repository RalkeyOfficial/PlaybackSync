<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\ContentIdentity;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use Ratchet\ConnectionInterface;

/**
 * Handles `EPISODE_CHANGE_REQUEST`: hard-resets the room's playback state
 * (paused at zero), updates ContentIdentity, and broadcasts EPISODE_CHANGE
 * to every connected client in the room.
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

		$identity = new ContentIdentity(
			$payload['providerId'],
			$payload['episodeId'],
			$payload['pageUrl'],
		);
		$runtime->contentIdentity = $identity;
		$eventId = $runtime->state->applyEpisodeReset($nowMs);
		$runtime->pushEvent(
			'episode_change',
			$identity->contentKey,
			$ctx->clientId,
			$nowMs,
			$eventId,
		);
		$client->lastEventId = $eventId;
		$client->markSeen($nowMs);

		$frame = $this->encoder->episodeChange($eventId, $identity, $nowMs);
		foreach ($runtime->clients() as $peer) {
			if ($peer->conn !== null) {
				$peer->conn->send($frame);
			}
		}
	}
}
