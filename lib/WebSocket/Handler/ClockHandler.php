<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use Ratchet\ConnectionInterface;

/**
 * Handles `CLOCK_PING`: replies immediately with `CLOCK_PONG` carrying the
 * server's receive and send timestamps so the client can compute its clock
 * offset and round-trip time using the standard 4-timestamp NTP-style math.
 *
 * Doesn't require a JOIN — clock samples taken before authentication still
 * give the client useful baseline data, and the worst case is an unsignalled
 * ping that costs nothing.
 */
class ClockHandler {

	public function __construct(
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param array{clientSendTime: float} $payload
	 */
	public function handle(
		ConnectionInterface $conn,
		ConnectionContext $ctx,
		array $payload,
		int $nowMs,
	): void {
		// Use a high-resolution `now` for the send timestamp so the client's
		// RTT calculation isn't biased by us pinning both timestamps to the
		// same coarse millisecond.
		$serverSendTimeMs = (int)(microtime(true) * 1000);
		$conn->send($this->encoder->clockPong(
			clientSendTime: $payload['clientSendTime'],
			serverRecvTimeMs: $nowMs,
			serverSendTimeMs: $serverSendTimeMs,
		));
		// Suppress unused-parameter notice while keeping the signature
		// uniform across handlers.
		unset($ctx);
	}
}
