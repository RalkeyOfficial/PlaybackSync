<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Service\Dto\RoomLiveState;

/**
 * Thin wrapper that turns a list of `Room` entities into a
 * `uuid => RoomLiveState|null` map by issuing a single batched
 * `PresenceClient::fetch()` call.
 *
 * Existence as a service (rather than letting controllers call the client
 * directly) keeps the controller dependency-free of the HTTP+HMAC
 * machinery and makes it cheap to mock in controller tests.
 */
class RoomLiveStateEnricher {

	public function __construct(
		private readonly PresenceClient $client,
	) {
	}

	/**
	 * @param list<Room> $rooms
	 * @return array<string, ?RoomLiveState>  Keyed by UUID. A `null` value
	 *                                        means "the daemon doesn't know
	 *                                        about this room" (or the daemon
	 *                                        isn't reachable). Callers render
	 *                                        that as `live: null`.
	 */
	public function enrich(array $rooms): array {
		if ($rooms === []) {
			return [];
		}

		$uuids = array_map(static fn (Room $r): string => $r->getUuid(), $rooms);
		$presence = $this->client->fetch($uuids);

		$out = [];
		foreach ($uuids as $uuid) {
			$out[$uuid] = $presence[$uuid] ?? null;
		}
		return $out;
	}
}
