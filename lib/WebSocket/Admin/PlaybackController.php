<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\RoomRuntime;

/**
 * Handles `POST /admin/rooms/{uuid}/playback` from the loopback admin server.
 * Drives the same `PlaybackState::applyPlay/applyPause/applySeek` calls and
 * event log that a connected client would via the `EVENT` frame, then
 * broadcasts the resulting `STATE` to every active client in the room.
 *
 * Events emitted here always have `actor: 'owner'` — these commands originate
 * from a room owner clicking the dashboard, not a Nextcloud administrator.
 * `actorId` carries the requesting Nextcloud userId when PHP forwards it; the
 * envelope's `playbackEventId` field is the per-room playback state version
 * (preserved at top level so `RoomRuntime::recentEventsSince` can keep mapping
 * the playback tail for client reconnect-replay).
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

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
	) {
	}

	/**
	 * @param string      $roomUuid     Target room UUID.
	 * @param string      $action       One of `play`, `pause`, `seek`, `reset`.
	 * @param float|null  $videoPos     Required and ≥0 for `seek`; ignored otherwise.
	 * @param int         $nowMs        Wall-clock timestamp the daemon assigns to the event.
	 * @param string|null $ownerUserId  Nextcloud userId of the room owner that triggered
	 *                                  this command, forwarded by PHP via the loopback
	 *                                  body. Used as `actorId` on the emitted envelope.
	 * @return self::RESULT_*
	 */
	public function apply(string $roomUuid, string $action, ?float $videoPos, int $nowMs, ?string $ownerUserId = null): string {
		$runtime = $this->registry->find($roomUuid);
		if ($runtime === null) {
			return self::RESULT_ROOM_NOT_FOUND;
		}

		switch ($action) {
			case self::ACTION_PLAY:
				$eventId = $runtime->state->applyPlay($nowMs);
				$this->emit($runtime, 'play', null, $nowMs, $eventId, $ownerUserId);
				break;

			case self::ACTION_PAUSE:
				$eventId = $runtime->state->applyPause($nowMs);
				$this->emit($runtime, 'pause', null, $nowMs, $eventId, $ownerUserId);
				break;

			case self::ACTION_SEEK:
				if ($videoPos === null || $videoPos < 0.0) {
					return self::RESULT_INVALID_POSITION;
				}
				$eventId = $runtime->state->applySeek($videoPos, $nowMs);
				$this->emit($runtime, 'seek', $videoPos, $nowMs, $eventId, $ownerUserId);
				break;

			case self::ACTION_RESET:
				// Reset = pause then seek to 0. Two events, last-write-wins
				// state — reconnecting clients replay both in order.
				$pauseId = $runtime->state->applyPause($nowMs);
				$this->emit($runtime, 'pause', null, $nowMs, $pauseId, $ownerUserId);
				$seekId = $runtime->state->applySeek(0.0, $nowMs);
				$this->emit($runtime, 'seek', 0.0, $nowMs, $seekId, $ownerUserId);
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

	/**
	 * Push the owner-originated playback envelope through `pushEnvelope` so the
	 * envelope wire format (`actor: 'owner'`, `actorId: <userId>`) survives all
	 * the way to SSE consumers. The `playbackEventId` is preserved at top level
	 * because `RoomRuntime::recentEventsSince` reads it from there to feed the
	 * legacy client reconnect-replay tail.
	 */
	private function emit(
		RoomRuntime $runtime,
		string $type,
		mixed $value,
		int $nowMs,
		int $playbackEventId,
		?string $ownerUserId,
	): void {
		$runtime->pushEnvelope([
			'ts' => $nowMs,
			'type' => $type,
			'category' => 'playback',
			'actor' => 'owner',
			'actorId' => $ownerUserId,
			'data' => $value === null ? null : ['value' => $value],
			'playbackEventId' => $playbackEventId,
		]);
	}
}
