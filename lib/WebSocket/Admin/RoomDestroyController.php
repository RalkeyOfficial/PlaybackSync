<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\RoomRegistry;

/**
 * Handles `POST /admin/rooms/{uuid}/destroy` from the loopback admin server.
 * Locates the live `RoomRuntime`, sends a final `ROOM_DELETED` error frame to
 * every connected client, closes their sockets, and drops the runtime from
 * the registry.
 *
 * Triggered by `RoomService::deleteOwnedRoom` after the DB row has been
 * deleted; without this, the daemon would keep accepting `EVENT` frames
 * against an orphaned runtime until the room's TTL elapsed and
 * `Tick::runOnce` fired the (mismatched) `ROOM_EXPIRED` path.
 *
 * Mirrors the close sequence in `Tick`'s `ROOM_EXPIRED` arm: ERROR frame,
 * `close()`, then `registry->remove`.
 */
class RoomDestroyController {

	public const RESULT_DESTROYED = 'destroyed';
	public const RESULT_ROOM_NOT_FOUND = 'room_not_found';

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param string $roomUuid Target room UUID.
	 * @param int    $nowMs    Wall-clock timestamp embedded in the ERROR frame.
	 * @return self::RESULT_*
	 */
	public function destroy(string $roomUuid, int $nowMs): string {
		$runtime = $this->registry->find($roomUuid);
		if ($runtime === null) {
			return self::RESULT_ROOM_NOT_FOUND;
		}

		foreach ($runtime->clients() as $client) {
			if ($client->conn !== null) {
				$client->conn->send($this->encoder->error('ROOM_DELETED', 'Room deleted by owner', $nowMs));
				$client->conn->close();
			}
		}
		$this->registry->remove($roomUuid);
		return self::RESULT_DESTROYED;
	}
}
