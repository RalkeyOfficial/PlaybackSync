<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\RoomRuntime;

/**
 * Read-only projection of `RoomRegistry` state for the rooms REST API.
 *
 * Pure value transformation — no I/O, no event-loop interaction. Lives on
 * the daemon side and is invoked by `PresenceHttpServer` for every authed
 * `GET /admin/rooms/presence` request.
 */
class PresenceController {

	/**
	 * Default cap on the number of clients returned per room. Keeps the
	 * response bounded for absurdly busy rooms; `connectedCount` still
	 * reflects the true total when the list is truncated. The runtime cap
	 * is configurable via the `max_clients_per_room` IAppConfig key and
	 * surfaced through `WsConfig::$maxClientsPerRoom`.
	 */
	public const MAX_CLIENTS_PER_ROOM = 50;

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly int $maxClientsPerRoom = self::MAX_CLIENTS_PER_ROOM,
	) {
	}

	/**
	 * Build the presence map for the requested room UUIDs.
	 *
	 * Rooms not currently held by the registry simply don't appear in the
	 * result — the PHP-side enricher treats a missing key as "daemon has no
	 * live state for this room", which collapses to `live: null` upstream.
	 *
	 * @param list<string> $uuids
	 * @return array<string, array{
	 *     connectedCount: int,
	 *     clients: list<array{clientId: string, nickname: string, isBuffering: bool, lastSeenMs: int}>,
	 *     playerState: string,
	 *     videoPos: float,
	 *     contentIdentity: ?array{providerId: string, episodeId: string, pageUrl: string, contentKey: string},
	 *     lastActivityMs: ?int
	 * }>
	 */
	public function presenceFor(array $uuids): array {
		$out = [];
		foreach ($uuids as $uuid) {
			$runtime = $this->registry->find($uuid);
			if ($runtime === null) {
				continue;
			}
			$out[$uuid] = $this->serializeRuntime($runtime);
		}
		return $out;
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
	private function serializeRuntime(RoomRuntime $runtime): array {
		$clients = [];
		$count = 0;
		foreach ($runtime->clients() as $client) {
			// Skip tombstoned clients — they're not actually connected.
			if ($client->conn === null) {
				continue;
			}
			$count++;
			if (count($clients) < $this->maxClientsPerRoom) {
				$clients[] = [
					'clientId' => $client->clientId,
					'nickname' => $client->nickname,
					'isBuffering' => $client->isBuffering,
					'lastSeenMs' => $client->lastSeenMs,
				];
			}
		}

		$identity = $runtime->contentIdentity;
		$identityArr = $identity === null ? null : [
			'providerId' => $identity->providerId,
			'episodeId' => $identity->episodeId,
			'pageUrl' => $identity->pageUrl,
			'contentKey' => $identity->contentKey,
		];

		// Playback state surfacing: report the extrapolated position the
		// server believes is current right now, not the last-stored value —
		// otherwise a "playing" room appears frozen between events.
		$nowMs = (int)(microtime(true) * 1000);
		$videoPos = $runtime->state->expectedTime($nowMs);

		return [
			'connectedCount' => $count,
			'clients' => $clients,
			'playerState' => $runtime->state->playerState,
			'videoPos' => $videoPos,
			'contentIdentity' => $identityArr,
			'lastActivityMs' => $runtime->lastActivityMs(),
		];
	}
}
