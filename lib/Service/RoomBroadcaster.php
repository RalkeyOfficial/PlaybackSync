<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

/**
 * Thin convenience wrapper over `AdminRoomBroadcastClient`. HTTP
 * controllers call these methods after a DB write to tell the daemon
 * to re-hydrate the runtime cache and broadcast the matching WS frame
 * (`CURSOR_CHANGE` / `PLAYLIST_UPDATE`).
 *
 * Three methods rather than one because the call sites read naturally
 * — "after cursor change, broadcast cursor change" — and the
 * controller doesn't need to know the kind-string constants.
 */
class RoomBroadcaster {

	public function __construct(
		private readonly AdminRoomBroadcastClient $client,
	) {
	}

	public function broadcastCursorChange(string $roomUuid, ?string $ownerUserId): void {
		$this->client->broadcast($roomUuid, AdminRoomBroadcastClient::KIND_CURSOR_CHANGE, $ownerUserId);
	}

	public function broadcastPlaylistUpdate(string $roomUuid, ?string $ownerUserId): void {
		$this->client->broadcast($roomUuid, AdminRoomBroadcastClient::KIND_PLAYLIST_UPDATE, $ownerUserId);
	}

	public function broadcastRoomState(string $roomUuid, ?string $ownerUserId): void {
		$this->client->broadcast($roomUuid, AdminRoomBroadcastClient::KIND_ROOM_STATE, $ownerUserId);
	}
}
