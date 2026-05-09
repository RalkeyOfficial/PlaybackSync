<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use Ratchet\ConnectionInterface;

/**
 * Handles `EVENT` (play/pause/seek): mutates the room's PlaybackState,
 * appends to the event log, and broadcasts the resulting `STATE` message
 * to every other client in the room.
 *
 * Rate-limited per connection so a misbehaving client can't flood the room
 * with seek storms.
 */
class EventHandler {

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param array{event: string, value: ?float, clientTs: int} $payload
	 */
	public function handle(
		ConnectionInterface $conn,
		ConnectionContext $ctx,
		array $payload,
		int $nowMs,
	): void {
		if (!$ctx->joined || $ctx->clientId === null) {
			throw new MessageException('NOT_JOINED', 'EVENT requires a prior JOIN', closeAfter: true);
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

		$eventId = match ($payload['event']) {
			'play' => $runtime->state->applyPlay($nowMs),
			'pause' => $runtime->state->applyPause($nowMs),
			'seek' => $runtime->state->applySeek($payload['value'] ?? 0.0, $nowMs),
			default => throw new MessageException('INVALID_MESSAGE', 'Unknown event'), // already validated, but exhaustive
		};

		$runtime->pushEvent(
			$payload['event'],
			$payload['event'] === 'seek' ? $payload['value'] : null,
			$ctx->clientId,
			$nowMs,
			$eventId,
		);

		$client->lastEventId = $eventId;
		$client->markSeen($nowMs);

		$frame = $this->encoder->state($runtime->state, $nowMs);
		foreach ($runtime->activeConnectionsExcept($ctx->clientId) as $peer) {
			$peer->send($frame);
		}
		// Echo back to sender too, so all clients converge on the same state
		// and the sender's own pendingEventId tracking stays consistent.
		$conn->send($frame);
	}
}
