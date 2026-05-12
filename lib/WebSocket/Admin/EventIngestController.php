<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\RoomRegistry;

/**
 * Handles `POST /admin/events` from the loopback admin server. Accepts a
 * PHP-originated envelope (room lifecycle events, Nextcloud-admin actions,
 * etc) and routes it into the right ring:
 *   - If `roomUuid` is set AND a live `RoomRuntime` exists for it, the
 *     envelope goes through `RoomRuntime::pushEnvelope` so it lands in the
 *     per-room ring and fans out to room subscribers.
 *   - Otherwise it appends to the cross-room ring via
 *     `RoomRegistry::appendGlobalEvent`.
 *
 * Both paths fan out to global subscribers — the daemon's admin SSE
 * consumers — so the admin viewer sees every event regardless of where the
 * envelope physically lives.
 *
 * Validation is strict: missing or non-string `type` / `category` / `actor`
 * is a 400. Unknown fields are dropped silently so PHP-side evolution can
 * add metadata without the daemon needing to learn about it.
 */
class EventIngestController {

	public const RESULT_ACCEPTED = 'accepted';
	public const RESULT_INVALID_PAYLOAD = 'invalid_payload';

	/**
	 * Envelope categories the daemon recognises. Anything outside this set
	 * is rejected — kept narrow so the admin UI's icon/colour mapping has a
	 * closed vocabulary to render.
	 */
	private const VALID_CATEGORIES = ['playback', 'presence', 'lifecycle', 'admin'];
	private const VALID_ACTORS = ['client', 'owner', 'admin', 'system'];

	public function __construct(
		private readonly RoomRegistry $registry,
	) {
	}

	/**
	 * @param array<string, mixed> $payload Raw decoded JSON body.
	 * @return array{result: 'accepted', id: int}|array{result: 'invalid_payload', error: string}
	 */
	public function apply(array $payload, int $nowMs): array {
		$type = $payload['type'] ?? null;
		$category = $payload['category'] ?? null;
		$actor = $payload['actor'] ?? null;
		if (!is_string($type) || $type === '') {
			return ['result' => self::RESULT_INVALID_PAYLOAD, 'error' => 'type'];
		}
		if (!is_string($category) || !in_array($category, self::VALID_CATEGORIES, true)) {
			return ['result' => self::RESULT_INVALID_PAYLOAD, 'error' => 'category'];
		}
		if (!is_string($actor) || !in_array($actor, self::VALID_ACTORS, true)) {
			return ['result' => self::RESULT_INVALID_PAYLOAD, 'error' => 'actor'];
		}

		$actorId = $payload['actorId'] ?? null;
		if ($actorId !== null && !is_string($actorId)) {
			return ['result' => self::RESULT_INVALID_PAYLOAD, 'error' => 'actorId'];
		}
		$roomUuid = $payload['roomUuid'] ?? null;
		if ($roomUuid !== null && !is_string($roomUuid)) {
			return ['result' => self::RESULT_INVALID_PAYLOAD, 'error' => 'roomUuid'];
		}
		$data = $payload['data'] ?? null;
		if ($data !== null && !is_array($data)) {
			return ['result' => self::RESULT_INVALID_PAYLOAD, 'error' => 'data'];
		}

		$envelope = [
			'ts' => $nowMs,
			'type' => $type,
			'category' => $category,
			'actor' => $actor,
			'actorId' => $actorId,
			'data' => $data,
		];

		if (is_string($roomUuid) && $roomUuid !== '') {
			$runtime = $this->registry->find($roomUuid);
			if ($runtime !== null) {
				// `pushEnvelope` fills in `id` + `roomUuid` and fans out to
				// both per-room and global subscribers via `publishRoomEvent`.
				$runtime->pushEnvelope($envelope);
				return ['result' => self::RESULT_ACCEPTED, 'id' => $this->latestEnvelopeId($runtime)];
			}
			$envelope['roomUuid'] = $roomUuid;
		}

		$id = $this->registry->appendGlobalEvent($envelope);
		return ['result' => self::RESULT_ACCEPTED, 'id' => $id];
	}

	private function latestEnvelopeId(\OCA\PlaybackSync\WebSocket\RoomRuntime $runtime): int {
		$tail = $runtime->envelopesSince(0);
		$last = end($tail);
		return is_array($last) ? (int)($last['id'] ?? 0) : 0;
	}
}
