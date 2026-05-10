<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\WsConfig;

/**
 * Handles `POST /admin/rooms/{uuid}/clients/{clientId}/disconnect` from the
 * loopback admin server. Locates the live `RoomRuntime`, kicks the named
 * client (sends a final `KICKED` error frame, closes the socket, and records
 * a reconnect block for `ws_kick_block_ms`), and reports back a small
 * outcome the HTTP layer can map to a status code.
 *
 * Pure value transformation around `RoomRuntime::kickClient` — no I/O of its
 * own — so the HTTP layer stays the only place that talks to Ratchet.
 */
class KickController {

	public const RESULT_KICKED = 'kicked';
	public const RESULT_ROOM_NOT_FOUND = 'room_not_found';
	public const RESULT_CLIENT_NOT_FOUND = 'client_not_found';

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
		private readonly WsConfig $config,
	) {
	}

	/**
	 * @return self::RESULT_*
	 */
	public function kick(string $roomUuid, string $clientId, int $nowMs): string {
		$runtime = $this->registry->find($roomUuid);
		if ($runtime === null) {
			return self::RESULT_ROOM_NOT_FOUND;
		}
		$kicked = $runtime->kickClient($clientId, $this->encoder, $this->config->kickBlockMs, $nowMs);
		return $kicked ? self::RESULT_KICKED : self::RESULT_CLIENT_NOT_FOUND;
	}
}
