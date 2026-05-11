<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\RoomRegistry;

/**
 * Handles `POST /admin/rooms/{uuid}/playback` from the loopback admin server.
 * Drives the same `PlaybackState::applyPlay/applyPause/applySeek` calls and
 * event log that a connected client would via the `EVENT` frame, then
 * broadcasts the resulting `STATE` to every active client in the room.
 *
 * Pure value transformation around `RoomRuntime` and `PlaybackState` — the
 * HTTP layer remains the only place that talks to Ratchet.
 */
class PlaybackController {

	public const RESULT_APPLIED = 'applied';
	public const RESULT_ROOM_NOT_FOUND = 'room_not_found';
	public const RESULT_INVALID_ACTION = 'invalid_action';
	public const RESULT_INVALID_POSITION = 'invalid_position';

	public const ACTION_PLAY = 'play';
	public const ACTION_PAUSE = 'pause';
	public const ACTION_SEEK = 'seek';
	public const ACTION_RESET = 'reset';

	public const ADMIN_CLIENT_ID = 'admin';

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @return self::RESULT_*
	 */
	public function apply(string $roomUuid, string $action, ?float $videoPos, int $nowMs): string {
		$runtime = $this->registry->find($roomUuid);
		if ($runtime === null) {
			return self::RESULT_ROOM_NOT_FOUND;
		}

		switch ($action) {
			case self::ACTION_PLAY:
				$eventId = $runtime->state->applyPlay($nowMs);
				$runtime->pushEvent('play', null, self::ADMIN_CLIENT_ID, $nowMs, $eventId);
				break;

			case self::ACTION_PAUSE:
				$eventId = $runtime->state->applyPause($nowMs);
				$runtime->pushEvent('pause', null, self::ADMIN_CLIENT_ID, $nowMs, $eventId);
				break;

			case self::ACTION_SEEK:
				if ($videoPos === null || $videoPos < 0.0) {
					return self::RESULT_INVALID_POSITION;
				}
				$eventId = $runtime->state->applySeek($videoPos, $nowMs);
				$runtime->pushEvent('seek', $videoPos, self::ADMIN_CLIENT_ID, $nowMs, $eventId);
				break;

			case self::ACTION_RESET:
				// Reset = pause then seek to 0. Two events, last-write-wins
				// state — reconnecting clients replay both in order.
				$pauseId = $runtime->state->applyPause($nowMs);
				$runtime->pushEvent('pause', null, self::ADMIN_CLIENT_ID, $nowMs, $pauseId);
				$seekId = $runtime->state->applySeek(0.0, $nowMs);
				$runtime->pushEvent('seek', 0.0, self::ADMIN_CLIENT_ID, $nowMs, $seekId);
				break;

			default:
				return self::RESULT_INVALID_ACTION;
		}

		$frame = $this->encoder->state($runtime->state, $nowMs);
		foreach ($runtime->activeConnectionsExcept(null) as $peer) {
			$peer->send($frame);
		}

		return self::RESULT_APPLIED;
	}
}
