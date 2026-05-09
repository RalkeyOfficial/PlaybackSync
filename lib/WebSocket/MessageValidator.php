<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use JsonException;

/**
 * Hand-rolled validators for client→server messages.
 *
 * The v1 message set is tiny enough that a JSON-Schema runtime would be
 * heavier than the validation logic itself. Each `validate*` method either
 * returns a normalised array or throws `MessageException` with a useful
 * `code`/`message` pair the router can ship straight to the client.
 */
class MessageValidator {

	public const ERR_INVALID_JSON = 'INVALID_JSON';
	public const ERR_INVALID_MESSAGE = 'INVALID_MESSAGE';
	public const ERR_UNKNOWN_TYPE = 'UNKNOWN_TYPE';

	/**
	 * @return array<string, mixed> the decoded envelope; caller dispatches on `type`
	 */
	public function parse(string $raw): array {
		try {
			$decoded = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
		} catch (JsonException $e) {
			throw new MessageException(self::ERR_INVALID_JSON, 'Message is not valid JSON');
		}
		if (!is_array($decoded) || !isset($decoded['type']) || !is_string($decoded['type'])) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'Missing or invalid "type"');
		}
		return $decoded;
	}

	/**
	 * @param array<string, mixed> $msg
	 * @return array{password: string, clientId: ?string, lastEventId: ?int, episodeId: ?string, providerId: ?string, pageUrl: ?string}
	 */
	public function validateJoin(array $msg): array {
		$password = $msg['password'] ?? null;
		if (!is_string($password) || $password === '') {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'JOIN.password missing or empty');
		}

		$clientId = $msg['clientId'] ?? null;
		if ($clientId !== null && (!is_string($clientId) || strlen($clientId) > 64)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'JOIN.clientId must be a string up to 64 chars');
		}

		$lastEventId = $msg['lastEventId'] ?? null;
		if ($lastEventId !== null && !is_int($lastEventId)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'JOIN.lastEventId must be an integer');
		}

		// Content identity fields are an all-or-nothing triple.
		$episodeId = $msg['episodeId'] ?? null;
		$providerId = $msg['providerId'] ?? null;
		$pageUrl = $msg['pageUrl'] ?? null;
		$provided = array_filter([$episodeId, $providerId, $pageUrl], static fn ($v) => $v !== null);
		if (count($provided) !== 0 && count($provided) !== 3) {
			throw new MessageException(
				self::ERR_INVALID_MESSAGE,
				'JOIN content identity must include all three of episodeId, providerId, pageUrl or none',
			);
		}
		foreach (['episodeId' => $episodeId, 'providerId' => $providerId, 'pageUrl' => $pageUrl] as $name => $value) {
			if ($value !== null && (!is_string($value) || $value === '' || strlen($value) > 1024)) {
				throw new MessageException(self::ERR_INVALID_MESSAGE, "JOIN.$name must be a non-empty string up to 1024 chars");
			}
		}

		return [
			'password' => $password,
			'clientId' => $clientId,
			'lastEventId' => $lastEventId,
			'episodeId' => $episodeId,
			'providerId' => $providerId,
			'pageUrl' => $pageUrl,
		];
	}

	/**
	 * @param array<string, mixed> $msg
	 * @return array{event: string, value: ?float, clientTs: int}
	 */
	public function validateEvent(array $msg): array {
		$event = $msg['event'] ?? null;
		if (!in_array($event, ['play', 'pause', 'seek'], true)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'EVENT.event must be play, pause, or seek');
		}
		$clientTs = $msg['clientTs'] ?? null;
		if (!is_int($clientTs)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'EVENT.clientTs must be an integer (ms)');
		}
		$value = null;
		if ($event === 'seek') {
			$rawValue = $msg['value'] ?? null;
			if (!is_int($rawValue) && !is_float($rawValue)) {
				throw new MessageException(self::ERR_INVALID_MESSAGE, 'EVENT.value (seconds) is required when event=seek');
			}
			$value = (float)$rawValue;
		}
		return ['event' => $event, 'value' => $value, 'clientTs' => $clientTs];
	}

	/**
	 * @param array<string, mixed> $msg
	 * @return array{episodeId: string, providerId: string, pageUrl: string, clientTs: int}
	 */
	public function validateEpisodeChange(array $msg): array {
		foreach (['episodeId', 'providerId', 'pageUrl'] as $field) {
			$value = $msg[$field] ?? null;
			if (!is_string($value) || $value === '' || strlen($value) > 1024) {
				throw new MessageException(self::ERR_INVALID_MESSAGE, "EPISODE_CHANGE_REQUEST.$field is required");
			}
		}
		$clientTs = $msg['clientTs'] ?? null;
		if (!is_int($clientTs)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'EPISODE_CHANGE_REQUEST.clientTs must be an integer (ms)');
		}
		return [
			'episodeId' => $msg['episodeId'],
			'providerId' => $msg['providerId'],
			'pageUrl' => $msg['pageUrl'],
			'clientTs' => $clientTs,
		];
	}

	/**
	 * @param array<string, mixed> $msg
	 * @return array{currentPos: float, playerState: string}
	 */
	public function validateHeartbeat(array $msg): array {
		$pos = $msg['currentPos'] ?? null;
		if (!is_int($pos) && !is_float($pos)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'HEARTBEAT.currentPos must be a number');
		}
		$playerState = $msg['playerState'] ?? null;
		if (!in_array($playerState, ['playing', 'paused', 'buffering'], true)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'HEARTBEAT.playerState must be playing, paused, or buffering');
		}
		return ['currentPos' => (float)$pos, 'playerState' => $playerState];
	}

	/**
	 * @param array<string, mixed> $msg
	 * @return array{clientSendTime: float}
	 */
	public function validateClockPing(array $msg): array {
		$t = $msg['clientSendTime'] ?? null;
		if (!is_int($t) && !is_float($t)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'CLOCK_PING.clientSendTime must be a number');
		}
		return ['clientSendTime' => (float)$t];
	}

	/**
	 * @param array<string, mixed> $msg
	 * @return array{videoPos: float}
	 */
	public function validateBuffer(array $msg): array {
		$pos = $msg['videoPos'] ?? null;
		if (!is_int($pos) && !is_float($pos)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'BUFFER.videoPos must be a number');
		}
		return ['videoPos' => (float)$pos];
	}
}
