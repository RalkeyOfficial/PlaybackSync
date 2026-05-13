<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Dto;

/**
 * Snapshot of a single room's live state, as returned by the WS daemon's
 * admin HTTP endpoint and merged into the rooms REST API response.
 *
 * Pure value object — no behaviour, no I/O. Field shape mirrors
 * `PresenceController::serializeRuntime()` on the daemon side.
 */
final class RoomLiveState {

	/**
	 * @param int $connectedCount True total of currently-connected clients
	 *                            in the room (may exceed `clients` length when
	 *                            the daemon truncated the list).
	 * @param list<array{clientId: string, nickname: string, isBuffering: bool, lastSeenMs: int}> $clients
	 * @param string $playerState  `'playing'` | `'paused'` | `'buffering'`.
	 * @param float  $videoPos     Server-extrapolated playback position, seconds.
	 * @param array{providerId: string, episodeId: string, pageUrl: string, contentKey: string}|null $contentIdentity
	 * @param int|null $lastActivityMs Latest activity timestamp known to the
	 *                                 daemon (max of client lastSeen and last
	 *                                 event ts), or null for an inert room.
	 */
	public function __construct(
		public readonly int $connectedCount,
		public readonly array $clients,
		public readonly string $playerState,
		public readonly float $videoPos,
		public readonly ?array $contentIdentity,
		public readonly ?int $lastActivityMs,
	) {
	}

	/**
	 * Build from the parsed-JSON shape returned by the daemon. Returns null
	 * if the input doesn't have the required fields — caller treats that as
	 * "no live state for this room".
	 *
	 * @param array<string, mixed> $raw
	 */
	public static function fromArray(array $raw): ?self {
		if (!isset($raw['connectedCount'], $raw['clients'], $raw['playerState'], $raw['videoPos'])) {
			return null;
		}

		$clients = [];
		foreach ($raw['clients'] as $c) {
			if (!is_array($c) || !isset($c['clientId'], $c['nickname'], $c['lastSeenMs'])) {
				continue;
			}
			$clients[] = [
				'clientId' => (string)$c['clientId'],
				'nickname' => (string)$c['nickname'],
				'isBuffering' => (bool)($c['isBuffering'] ?? false),
				'lastSeenMs' => (int)$c['lastSeenMs'],
			];
		}

		$identity = null;
		if (isset($raw['contentIdentity']) && is_array($raw['contentIdentity'])) {
			$ci = $raw['contentIdentity'];
			if (isset($ci['providerId'], $ci['episodeId'], $ci['pageUrl'], $ci['contentKey'])) {
				$identity = [
					'providerId' => (string)$ci['providerId'],
					'episodeId' => (string)$ci['episodeId'],
					'pageUrl' => (string)$ci['pageUrl'],
					'contentKey' => (string)$ci['contentKey'],
				];
			}
		}

		return new self(
			connectedCount: (int)$raw['connectedCount'],
			clients: $clients,
			playerState: (string)$raw['playerState'],
			videoPos: (float)$raw['videoPos'],
			contentIdentity: $identity,
			lastActivityMs: isset($raw['lastActivityMs']) ? (int)$raw['lastActivityMs'] : null,
		);
	}

	/**
	 * @return array{
	 *     connectedCount: int,
	 *     clients: list<array{clientId: string, nickname: string, isBuffering: bool, lastSeenMs: int}>,
	 *     playerState: string,
	 *     videoPos: float,
	 *     contentIdentity: ?array{providerId: string, episodeId: string, pageUrl: string, contentKey: string},
	 *     lastActivityMs: ?int
	 * }
	 */
	public function toArray(): array {
		return [
			'connectedCount' => $this->connectedCount,
			'clients' => $this->clients,
			'playerState' => $this->playerState,
			'videoPos' => $this->videoPos,
			'contentIdentity' => $this->contentIdentity,
			'lastActivityMs' => $this->lastActivityMs,
		];
	}
}
