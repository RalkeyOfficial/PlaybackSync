<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use JsonException;
use OCA\PlaybackSync\Service\PlaylistService;

/**
 * Hand-rolled validators for client→server messages.
 *
 * The v2 message set is small enough that a JSON-Schema runtime is
 * heavier than the validation logic itself. Each `validate*` method either
 * returns a normalised array or throws `MessageException` with a
 * `code` / `message` pair the router can ship straight to the client.
 */
class MessageValidator {

	public const ERR_INVALID_JSON = 'INVALID_JSON';
	public const ERR_INVALID_MESSAGE = 'INVALID_MESSAGE';
	public const ERR_UNKNOWN_TYPE = 'UNKNOWN_TYPE';

	private const MAX_STRING = 1024;

	/**
	 * @return array<string, mixed> the decoded envelope; caller dispatches on `type`
	 */
	public function parse(string $raw): array {
		try {
			$decoded = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
		} catch (JsonException) {
			throw new MessageException(self::ERR_INVALID_JSON, 'Message is not valid JSON');
		}
		if (!is_array($decoded) || !isset($decoded['type']) || !is_string($decoded['type'])) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'Missing or invalid "type"');
		}
		return $decoded;
	}

	/**
	 * @param array<string, mixed> $msg
	 * @return array{
	 *   password: string,
	 *   clientId: ?string,
	 *   lastEventId: ?int,
	 *   currentlyShowing: ?array{providerId: string, videoId: string, pageUrl: string},
	 *   catalogFragment: list<array{providerId: string, videoId: string, pageUrl: string, label?: ?string, episodeNumber?: ?int, seasonNumber?: ?int}>
	 * }
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

		$currentlyShowing = null;
		if (isset($msg['currentlyShowing'])) {
			$currentlyShowing = $this->parseVideoRef($msg['currentlyShowing'], 'JOIN.currentlyShowing');
		}

		$catalogFragment = [];
		if (isset($msg['catalogFragment'])) {
			$catalogFragment = $this->parseCatalogFragment($msg['catalogFragment'], 'JOIN.catalogFragment');
		}

		return [
			'password' => $password,
			'clientId' => $clientId,
			'lastEventId' => $lastEventId,
			'currentlyShowing' => $currentlyShowing,
			'catalogFragment' => $catalogFragment,
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
	 * Validate a `CURSOR_CHANGE_REQUEST`. Either `targetEntryId` (string,
	 * resolves an existing playlist entry) or `target` (a full video
	 * reference, used for freeform auto-append or for resolving a video
	 * already in the playlist). Exactly one of the two must be present.
	 *
	 * @param array<string, mixed> $msg
	 * @return array{
	 *   targetEntryId: ?string,
	 *   target: ?array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int},
	 *   clientTs: int
	 * }
	 */
	public function validateCursorChangeRequest(array $msg): array {
		$clientTs = $msg['clientTs'] ?? null;
		if (!is_int($clientTs)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'CURSOR_CHANGE_REQUEST.clientTs must be an integer (ms)');
		}

		$entryId = $msg['targetEntryId'] ?? null;
		$rawTarget = $msg['target'] ?? null;

		if ($entryId !== null && $rawTarget !== null) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'CURSOR_CHANGE_REQUEST takes targetEntryId OR target, not both');
		}
		if ($entryId === null && $rawTarget === null) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'CURSOR_CHANGE_REQUEST requires either targetEntryId or target');
		}

		if ($entryId !== null) {
			if (!is_string($entryId) || $entryId === '' || strlen($entryId) > 64) {
				throw new MessageException(self::ERR_INVALID_MESSAGE, 'CURSOR_CHANGE_REQUEST.targetEntryId must be a non-empty string up to 64 chars');
			}
			return ['targetEntryId' => $entryId, 'target' => null, 'clientTs' => $clientTs];
		}

		$target = $this->parseVideoRef($rawTarget, 'CURSOR_CHANGE_REQUEST.target', allowMetadata: true);
		return ['targetEntryId' => null, 'target' => $target, 'clientTs' => $clientTs];
	}

	/**
	 * Validate a `PLAYLIST_UPDATE` from a client (scrape contribution).
	 * Enforces the per-message entry cap; the per-room cap is enforced
	 * later by `PlaylistService::merge`.
	 *
	 * @param array<string, mixed> $msg
	 * @return array{
	 *   entries: list<array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int, source: ?string}>,
	 *   clientTs: int
	 * }
	 */
	public function validatePlaylistUpdate(array $msg): array {
		$clientTs = $msg['clientTs'] ?? null;
		if (!is_int($clientTs)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'PLAYLIST_UPDATE.clientTs must be an integer (ms)');
		}
		$rawEntries = $msg['entries'] ?? null;
		if (!is_array($rawEntries) || $rawEntries === []) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'PLAYLIST_UPDATE.entries must be a non-empty array');
		}
		if (count($rawEntries) > PlaylistService::PER_MESSAGE_CAP) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, 'PLAYLIST_UPDATE.entries exceeds per-message cap of ' . PlaylistService::PER_MESSAGE_CAP);
		}
		$entries = [];
		foreach ($rawEntries as $i => $raw) {
			$entries[] = $this->parsePlaylistEntryShape($raw, 'PLAYLIST_UPDATE.entries[' . $i . ']');
		}
		return ['entries' => $entries, 'clientTs' => $clientTs];
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

	/**
	 * Normalise a `(providerId, videoId, pageUrl)` triple plus optional
	 * metadata. Used for `JOIN.currentlyShowing` and for the raw-target
	 * variant of `CURSOR_CHANGE_REQUEST`.
	 *
	 * @param mixed $raw    The candidate shape (must be an associative array).
	 * @param string $label Field path for error messages.
	 * @param bool $allowMetadata When true, accepts optional `label`, `episodeNumber`, `seasonNumber`.
	 * @return ($allowMetadata is true ? array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int} : array{providerId: string, videoId: string, pageUrl: string})
	 */
	private function parseVideoRef(mixed $raw, string $label, bool $allowMetadata = false): array {
		if (!is_array($raw)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, $label . ' must be an object');
		}
		$out = [];
		foreach (['providerId', 'videoId', 'pageUrl'] as $field) {
			$value = $raw[$field] ?? null;
			if (!is_string($value) || $value === '' || strlen($value) > self::MAX_STRING) {
				throw new MessageException(self::ERR_INVALID_MESSAGE, $label . '.' . $field . ' must be a non-empty string up to ' . self::MAX_STRING . ' chars');
			}
			$out[$field] = $value;
		}
		if (!$allowMetadata) {
			return $out;
		}
		$out['label'] = $this->maybeString($raw['label'] ?? null, $label . '.label');
		$out['episodeNumber'] = $this->maybeInt($raw['episodeNumber'] ?? null, $label . '.episodeNumber');
		$out['seasonNumber'] = $this->maybeInt($raw['seasonNumber'] ?? null, $label . '.seasonNumber');
		return $out;
	}

	/**
	 * @param mixed $raw The raw `catalogFragment` value (must be an array).
	 * @param string $label Field path for error messages.
	 * @return list<array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int}>
	 */
	private function parseCatalogFragment(mixed $raw, string $label): array {
		if (!is_array($raw)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, $label . ' must be an array');
		}
		if (count($raw) > PlaylistService::PER_MESSAGE_CAP) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, $label . ' exceeds per-message cap of ' . PlaylistService::PER_MESSAGE_CAP);
		}
		$out = [];
		foreach ($raw as $i => $item) {
			$out[] = $this->parseVideoRef($item, $label . '[' . $i . ']', allowMetadata: true);
		}
		return $out;
	}

	/**
	 * @param mixed $raw Candidate playlist entry shape (must be an array).
	 * @param string $label Field path for error messages.
	 * @return array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int, source: ?string}
	 */
	private function parsePlaylistEntryShape(mixed $raw, string $label): array {
		$ref = $this->parseVideoRef($raw, $label, allowMetadata: true);
		$rawSource = is_array($raw) ? ($raw['source'] ?? null) : null;
		$source = null;
		if ($rawSource !== null) {
			if (!is_string($rawSource) || !in_array($rawSource, ['scraped', 'curated', 'auto_appended'], true)) {
				throw new MessageException(self::ERR_INVALID_MESSAGE, $label . '.source must be one of scraped|curated|auto_appended');
			}
			$source = $rawSource;
		}
		return $ref + ['source' => $source];
	}

	private function maybeString(mixed $value, string $label): ?string {
		if ($value === null) {
			return null;
		}
		if (!is_string($value) || strlen($value) > self::MAX_STRING) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, $label . ' must be a string up to ' . self::MAX_STRING . ' chars');
		}
		return $value;
	}

	private function maybeInt(mixed $value, string $label): ?int {
		if ($value === null) {
			return null;
		}
		if (!is_int($value)) {
			throw new MessageException(self::ERR_INVALID_MESSAGE, $label . ' must be an integer');
		}
		return $value;
	}
}
