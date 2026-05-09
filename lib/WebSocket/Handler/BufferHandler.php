<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use Ratchet\ConnectionInterface;

/**
 * Handles `BUFFER_START` / `BUFFER_END`. The server only tracks an
 * `isBuffering` flag per client to suppress drift correction while the
 * client's playback engine is stalled. On `BUFFER_END` the client gets a
 * fresh per-client `ROOM_STATE` so it can resync to the current expected
 * position before any `SYNC_ADJUST` arrives.
 */
class BufferHandler {

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param array{videoPos: float} $payload
	 */
	public function handleStart(
		ConnectionInterface $conn,
		ConnectionContext $ctx,
		array $payload,
		int $nowMs,
	): void {
		[$runtime, $client] = $this->resolve($ctx);
		$client->isBuffering = true;
		$client->markSeen($nowMs);
		unset($conn, $payload, $runtime); // shape-uniform signature; broadcast is intentional no-op
	}

	/**
	 * @param array{videoPos: float} $payload
	 */
	public function handleEnd(
		ConnectionInterface $conn,
		ConnectionContext $ctx,
		array $payload,
		int $nowMs,
	): void {
		[$runtime, $client] = $this->resolve($ctx);
		$client->isBuffering = false;
		$client->markSeen($nowMs);

		$conn->send($this->encoder->roomState(
			$client->clientId,
			$runtime->state,
			$runtime->contentIdentity,
			$nowMs,
		));
		unset($payload);
	}

	/**
	 * @return array{0: \OCA\PlaybackSync\WebSocket\RoomRuntime, 1: \OCA\PlaybackSync\WebSocket\ClientConnection}
	 */
	private function resolve(ConnectionContext $ctx): array {
		if (!$ctx->joined || $ctx->clientId === null) {
			throw new MessageException('NOT_JOINED', 'Buffer signal requires a prior JOIN', closeAfter: true);
		}
		$runtime = $this->registry->find($ctx->roomUuid);
		if ($runtime === null) {
			throw new MessageException('ROOM_NOT_FOUND', 'Room is no longer active', closeAfter: true);
		}
		$client = $runtime->getClient($ctx->clientId);
		if ($client === null) {
			throw new MessageException('NOT_JOINED', 'Client is not in the room', closeAfter: true);
		}
		return [$runtime, $client];
	}
}
