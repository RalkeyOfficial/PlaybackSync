<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\WsConfig;
use Ratchet\ConnectionInterface;

/**
 * Handles `HEARTBEAT`: keeps the connection alive, tracks the buffering flag,
 * and emits per-client `SYNC_ADJUST` when the client's reported position has
 * drifted beyond the configured threshold.
 *
 * Drift correction is suppressed within `driftCooldownMs` of the last
 * explicit event in the room (so a recent play/seek doesn't immediately
 * trigger a corrective seek before the client has finished applying it).
 */
class HeartbeatHandler {

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
		private readonly WsConfig $config,
	) {
	}

	/**
	 * @param array{currentPos: float, playerState: string} $payload
	 */
	public function handle(
		ConnectionInterface $conn,
		ConnectionContext $ctx,
		array $payload,
		int $nowMs,
	): void {
		if (!$ctx->joined || $ctx->clientId === null) {
			throw new MessageException('NOT_JOINED', 'HEARTBEAT requires a prior JOIN', closeAfter: true);
		}

		$runtime = $this->registry->find($ctx->roomUuid);
		if ($runtime === null) {
			return; // room gone; the close handler will tear this connection down
		}
		$client = $runtime->getClient($ctx->clientId);
		if ($client === null) {
			return;
		}

		$client->markSeen($nowMs);
		$client->isBuffering = $payload['playerState'] === 'buffering';

		// Skip reconciliation in the cooldown window or when the client is
		// already buffering — sending a correction in either case is noise.
		if ($client->isBuffering) {
			return;
		}
		if ($runtime->state->isInCooldown($nowMs, $this->config->driftCooldownMs)) {
			return;
		}

		$expected = $runtime->state->expectedTime($nowMs);
		$driftMs = ($payload['currentPos'] - $expected) * 1000.0;
		$absDrift = abs($driftMs);

		if ($absDrift < $this->config->driftNudgeThresholdMs) {
			return;
		}

		$mode = $absDrift >= $this->config->driftSeekThresholdMs ? 'seek' : 'nudge-rate';
		$conn->send($this->encoder->syncAdjust($nowMs, $expected, $mode));
	}
}
