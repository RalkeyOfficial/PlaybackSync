<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use React\EventLoop\TimerInterface;

/**
 * Per-connection state held by the router. One instance is associated with
 * each open WebSocket via SplObjectStorage.
 *
 * `roomUuid` is set from the URL on `onOpen` so the JOIN handler can resolve
 * the room without re-parsing the URL. `clientId` is set after a successful
 * JOIN so subsequent messages can find the right ClientConnection inside the
 * RoomRuntime.
 */
class ConnectionContext {
	public ?string $clientId = null;
	public bool $joined = false;
	public ?TimerInterface $joinTimer = null;

	public function __construct(
		public readonly string $roomUuid,
	) {
	}
}
