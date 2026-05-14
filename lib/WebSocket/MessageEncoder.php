<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use OCA\PlaybackSync\Db\PlaylistEntry;

/**
 * Builds JSON envelopes for every server→client message in the v1 protocol.
 *
 * Every method returns the wire-format string ready for
 * `ConnectionInterface::send()`. Keeping the encoder isolated lets the
 * handlers express intent ("send a STATE") instead of hand-rolling JSON
 * objects, and makes the protocol shape easy to spot in one file.
 *
 * The v1 wire frames still carry the legacy `providerId` / `episodeId` /
 * `pageUrl` / `contentKey` fields. With the new playlist+cursor data
 * substrate, those fields are derived from the room's current cursor entry
 * — `videoId` plays the role of the old `episodeId` on the wire. The
 * protocol spec will rename these fields and add `entryId` proper.
 */
class MessageEncoder {

	public function error(string $code, string $message, int $serverTsMs): string {
		return $this->encode([
			'type' => 'ERROR',
			'code' => $code,
			'message' => $message,
			'serverTs' => $serverTsMs,
		]);
	}

	/**
	 * @param list<array{type: string, value?: mixed, clientId: string, ts: int, eventId: int}> $recentEvents
	 */
	public function roomState(
		string $clientId,
		PlaybackState $state,
		?PlaylistEntry $cursorEntry,
		int $serverTsMs,
		array $recentEvents = [],
	): string {
		$payload = [
			'type' => 'ROOM_STATE',
			'clientId' => $clientId,
			'playerState' => $state->playerState,
			'videoPos' => $state->expectedTime($serverTsMs),
			'lastEventId' => $state->eventId,
			'serverTs' => $serverTsMs,
		];
		$cursor = $this->encodeCursor($cursorEntry);
		if ($cursor !== null) {
			$payload += $cursor;
		}
		if ($recentEvents !== []) {
			$payload['recentEvents'] = $recentEvents;
		}
		return $this->encode($payload);
	}

	public function state(PlaybackState $state, int $serverTsMs): string {
		return $this->encode([
			'type' => 'STATE',
			'playerState' => $state->playerState,
			'videoPos' => $state->expectedTime($serverTsMs),
			'eventId' => $state->eventId,
			'serverTs' => $serverTsMs,
		]);
	}

	public function episodeChange(int $eventId, PlaylistEntry $cursorEntry, int $serverTsMs): string {
		$cursor = $this->encodeCursor($cursorEntry);
		return $this->encode([
			'type' => 'EPISODE_CHANGE',
			'eventId' => $eventId,
			'serverTs' => $serverTsMs,
		] + ($cursor ?? []));
	}

	public function syncAdjust(int $serverTsMs, float $targetPos, string $mode): string {
		return $this->encode([
			'type' => 'SYNC_ADJUST',
			'serverTime' => $serverTsMs,
			'targetPos' => $targetPos,
			'mode' => $mode,
		]);
	}

	public function clockPong(float $clientSendTime, int $serverRecvTimeMs, int $serverSendTimeMs): string {
		return $this->encode([
			'type' => 'CLOCK_PONG',
			'clientSendTime' => $clientSendTime,
			'serverRecvTime' => $serverRecvTimeMs,
			'serverSendTime' => $serverSendTimeMs,
		]);
	}

	/**
	 * Project a `PlaylistEntry` onto the legacy v1 wire shape:
	 * `providerId` / `episodeId` / `pageUrl` / `contentKey`. The
	 * `episodeId` field carries the entry's `videoId` for backwards
	 * compatibility; the protocol spec will rename it on the wire.
	 *
	 * Returns `null` when there is no current cursor (empty playlist).
	 *
	 * @return ?array{providerId: string, episodeId: string, pageUrl: string, contentKey: string}
	 */
	private function encodeCursor(?PlaylistEntry $cursorEntry): ?array {
		if ($cursorEntry === null) {
			return null;
		}
		return [
			'providerId' => $cursorEntry->providerId,
			'episodeId' => $cursorEntry->videoId,
			'pageUrl' => $cursorEntry->pageUrl,
			'contentKey' => self::deriveContentKey(
				$cursorEntry->providerId,
				$cursorEntry->videoId,
				$cursorEntry->pageUrl,
			),
		];
	}

	/**
	 * Stable fingerprint used by the v1 wire for content equality. Same
	 * algorithm as the retired `ContentIdentity::deriveKey`: lowercased
	 * provider + lowercased videoId + raw pageUrl. The pageUrl is left
	 * alone because path case can be load-bearing on some sites.
	 */
	public static function deriveContentKey(string $providerId, string $videoId, string $pageUrl): string {
		return hash('sha256', strtolower($providerId) . ':' . strtolower($videoId) . ':' . $pageUrl);
	}

	private function encode(array $payload): string {
		return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
	}
}
