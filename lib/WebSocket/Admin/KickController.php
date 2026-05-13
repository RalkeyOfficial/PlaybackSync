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
 * Emits a `client_kicked` envelope (`actor: 'owner', actorId: $ownerUserId`)
 * *before* the kick fires so consumers see the kick decision land before the
 * follow-up `client_left` (`reason: 'closed'`) that the socket-close path
 * publishes a moment later.
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
	 * @param string      $roomUuid    Target room UUID.
	 * @param string      $clientId    Client UUID to disconnect.
	 * @param int         $nowMs       Wall-clock timestamp for the envelope + kick block.
	 * @param string|null $ownerUserId Nextcloud userId of the room owner that issued the
	 *                                 kick, forwarded by PHP. Used as `actorId` on the
	 *                                 emitted `client_kicked` envelope.
	 * @return self::RESULT_*
	 */
	public function kick(string $roomUuid, string $clientId, int $nowMs, ?string $ownerUserId = null): string {
		$runtime = $this->registry->find($roomUuid);
		if ($runtime === null) {
			return self::RESULT_ROOM_NOT_FOUND;
		}
		$client = $runtime->getClient($clientId);
		if ($client === null) {
			return self::RESULT_CLIENT_NOT_FOUND;
		}

		$runtime->pushEnvelope([
			'ts' => $nowMs,
			'type' => 'client_kicked',
			'category' => 'presence',
			'actor' => 'owner',
			'actorId' => $ownerUserId,
			'data' => ['nickname' => $client->nickname],
		]);

		$kicked = $runtime->kickClient($clientId, $this->encoder, $this->config->kickBlockMs, $nowMs);
		return $kicked ? self::RESULT_KICKED : self::RESULT_CLIENT_NOT_FOUND;
	}
}
