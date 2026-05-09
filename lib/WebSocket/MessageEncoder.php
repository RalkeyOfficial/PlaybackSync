<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

/**
 * Builds JSON envelopes for every server→client message in the v1 protocol.
 *
 * Every method returns the wire-format string ready for
 * `ConnectionInterface::send()`. Keeping the encoder isolated lets the
 * handlers express intent ("send a STATE") instead of hand-rolling JSON
 * objects, and makes the protocol shape easy to spot in one file.
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
		?ContentIdentity $ci,
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
		if ($ci !== null) {
			$payload['providerId'] = $ci->providerId;
			$payload['episodeId'] = $ci->episodeId;
			$payload['pageUrl'] = $ci->pageUrl;
			$payload['contentKey'] = $ci->contentKey;
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

	public function episodeChange(int $eventId, ContentIdentity $ci, int $serverTsMs): string {
		return $this->encode([
			'type' => 'EPISODE_CHANGE',
			'eventId' => $eventId,
			'providerId' => $ci->providerId,
			'episodeId' => $ci->episodeId,
			'pageUrl' => $ci->pageUrl,
			'contentKey' => $ci->contentKey,
			'serverTs' => $serverTsMs,
		]);
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

	public function contentMismatch(string $expectedKey, ?string $reportedKey, int $serverTsMs): string {
		$payload = [
			'type' => 'CONTENT_MISMATCH',
			'expectedContentKey' => $expectedKey,
			'serverTs' => $serverTsMs,
		];
		if ($reportedKey !== null) {
			$payload['reportedContentKey'] = $reportedKey;
		}
		return $this->encode($payload);
	}

	private function encode(array $payload): string {
		return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
	}
}
