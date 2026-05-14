<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\Exceptions\CreateRestrictedException;
use OCA\PlaybackSync\Service\Exceptions\InvalidRoomInputException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistCapExceededException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\ToggleConflictException;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IAppConfig;
use OCP\IGroupManager;
use OCP\Security\IHasher;

class RoomService {

	public const MAX_TTL_SECONDS = 86400;
	public const DEFAULT_TTL_SECONDS = 86400;
	public const PASSWORD_LENGTH = 16;
	public const NAME_MAX_LENGTH = 100;

	private const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

	public function __construct(
		private RoomMapper $mapper,
		private IHasher $hasher,
		private IAppConfig $appConfig,
		private IGroupManager $groupManager,
		private ITimeFactory $timeFactory,
		private AdminKickClient $adminKickClient,
		private AdminPlaybackClient $adminPlaybackClient,
		private AdminEventClient $adminEventClient,
	) {
	}

	public function assertCanCreate(string $userId): void {
		$restrict = $this->appConfig->getValueBool(Application::APP_ID, 'restrict_to_admins', false);
		if ($restrict && !$this->groupManager->isAdmin($userId)) {
			throw new CreateRestrictedException('Room creation is restricted to administrators.');
		}
	}

	/**
	 * Create a room and atomically seed its playlist (curated) with the
	 * supplied `initialEntries`.
	 *
	 * @param string $bootstrapUrl Share-link redirect target.
	 * @param list<array{providerId: string, videoId: string, pageUrl: string, label?: string|null, episodeNumber?: int|null, seasonNumber?: int|null}> $initialEntries
	 * @return array{room: Room, plainPassword: string}
	 */
	public function createRoom(
		string $userId,
		string $bootstrapUrl,
		?string $name,
		?int $ttlSeconds,
		bool $singleMode = false,
		bool $freeformMode = false,
		array $initialEntries = [],
	): array {
		$this->assertCanCreate($userId);

		$bootstrapUrl = trim($bootstrapUrl);
		if ($bootstrapUrl === '' || !$this->isValidHttpUrl($bootstrapUrl)) {
			throw new InvalidRoomInputException('bootstrapUrl must be a valid http(s) URL.');
		}

		$this->assertTogglesNotConflicting($singleMode, $freeformMode);

		$name = $name !== null ? trim($name) : null;
		if ($name === '') {
			$name = null;
		}
		if ($name !== null && mb_strlen($name) > self::NAME_MAX_LENGTH) {
			throw new InvalidRoomInputException('name exceeds maximum length.');
		}

		$maxTtl = $this->getMaxTtlSeconds();
		$ttl = $ttlSeconds ?? $this->getDefaultTtlSeconds($maxTtl);
		if ($ttl < 1 || $ttl > $maxTtl) {
			throw new InvalidRoomInputException('ttl must be between 1 and ' . $maxTtl . ' seconds.');
		}

		$nowMs = $this->timeFactory->getTime() * 1000;
		$nowSec = $this->timeFactory->getTime();
		$plainPassword = $this->generatePassword();

		$room = new Room();
		$room->setUuid($this->generateUuidV4());
		$room->setOwnerUserId($userId);
		$room->setName($name);
		$room->setBootstrapUrl($bootstrapUrl);
		$room->setPasswordHash($this->hasher->hash($plainPassword));
		$room->setSingleMode($singleMode);
		$room->setFreeformMode($freeformMode);
		$room->setCursorEntryId(null);
		$room->setPlaylistEntries($this->buildInitialEntries($initialEntries, $userId, $nowSec));
		$room->setCreatedAt($nowMs);
		$room->setExpiresAt($nowMs + ($ttl * 1000));

		$room = $this->mapper->insert($room);

		$this->adminEventClient->record(
			'room_created',
			'lifecycle',
			'owner',
			$userId,
			$room->getUuid(),
			[
				'name' => $room->getName(),
				'ttlSeconds' => $ttl,
				'singleMode' => $singleMode,
				'freeformMode' => $freeformMode,
				'initialEntryCount' => count($initialEntries),
			],
		);

		return ['room' => $room, 'plainPassword' => $plainPassword];
	}

	/**
	 * Flip one or both mode toggles on an existing room. Either argument
	 * may be `null` to leave that toggle unchanged. Throws
	 * `ToggleConflictException` if the resulting combination would be
	 * both modes enabled.
	 */
	public function setToggles(string $userId, string $uuid, ?bool $single, ?bool $freeform): Room {
		$room = $this->getOwnedRoom($userId, $uuid);
		$nextSingle = $single ?? $room->getSingleMode();
		$nextFreeform = $freeform ?? $room->getFreeformMode();
		$this->assertTogglesNotConflicting($nextSingle, $nextFreeform);
		$room->setSingleMode($nextSingle);
		$room->setFreeformMode($nextFreeform);
		return $this->mapper->update($room);
	}

	/**
	 * @return Room[]
	 */
	public function listForOwner(string $userId): array {
		$now = $this->timeFactory->getTime() * 1000;
		return $this->mapper->findActiveByOwner($userId, $now);
	}

	public function getOwnedRoom(string $userId, string $uuid): Room {
		try {
			$room = $this->mapper->findByUuid($uuid);
		} catch (DoesNotExistException) {
			throw new RoomNotFoundException('Room not found.');
		}

		// Hide ownership from other users by returning the same 404 surface.
		$now = $this->timeFactory->getTime() * 1000;
		if ($room->getOwnerUserId() !== $userId || $room->getExpiresAt() <= $now) {
			throw new RoomNotFoundException('Room not found.');
		}

		return $room;
	}

	/**
	 * Look up a non-expired room by UUID without enforcing ownership.
	 *
	 * Used by the public share endpoint, which gates on the room password
	 * rather than the caller's Nextcloud identity. Collapses unknown and
	 * expired into the same `RoomNotFoundException` surface so the controller
	 * cannot accidentally leak existence of an expired room.
	 */
	public function getActiveRoom(string $uuid): Room {
		try {
			$room = $this->mapper->findByUuid($uuid);
		} catch (DoesNotExistException) {
			throw new RoomNotFoundException('Room not found.');
		}

		$now = $this->timeFactory->getTime() * 1000;
		if ($room->getExpiresAt() <= $now) {
			throw new RoomNotFoundException('Room not found.');
		}

		return $room;
	}

	public function deleteOwnedRoom(string $userId, string $uuid): void {
		$room = $this->getOwnedRoom($userId, $uuid);
		$this->mapper->delete($room);
		$this->adminEventClient->record(
			'room_deleted',
			'lifecycle',
			'owner',
			$userId,
			$room->getUuid(),
			['name' => $room->getName()],
		);
	}

	/**
	 * Forcibly disconnect one connected client from the owner's room.
	 *
	 * Throws `RoomNotFoundException` when the caller doesn't own (or the
	 * room has expired) — same opacity as `getOwnedRoom`. Forwards lower-level
	 * `ClientNotFoundException` / `KickFailedException` from the admin client
	 * unchanged so the controller can map them to distinct status codes.
	 */
	public function kickClient(string $userId, string $uuid, string $clientId): void {
		$room = $this->getOwnedRoom($userId, $uuid);
		$this->adminKickClient->kick($room->getUuid(), $clientId, $userId);
	}

	/**
	 * Send an owner-initiated playback command to the daemon for the room.
	 *
	 * Throws `RoomNotFoundException` when the caller doesn't own (or the room
	 * has expired) — same opacity as `getOwnedRoom`. Forwards lower-level
	 * `RoomNotLiveException` / `PlaybackCommandFailedException` from the admin
	 * client unchanged so the controller can map them to distinct status codes.
	 *
	 * @param string     $action   One of `play`, `pause`, `seek`, `reset`.
	 * @param float|null $videoPos Target position in seconds when `$action` is
	 *                             `seek`. Required for seek; ignored otherwise.
	 */
	public function sendPlaybackCommand(string $userId, string $uuid, string $action, ?float $videoPos): void {
		$room = $this->getOwnedRoom($userId, $uuid);
		$this->adminPlaybackClient->apply($room->getUuid(), $action, $videoPos, $userId);
	}

	/**
	 * Verify a plaintext password against a room's stored hash.
	 *
	 * Used by the WebSocket layer on `JOIN` so it doesn't have to reach for
	 * IHasher directly. Returns false on mismatch and true on match — never
	 * throws — so the caller can shape its own error response.
	 */
	public function verifyPassword(Room $room, string $plainPassword): bool {
		return $this->hasher->verify($plainPassword, $room->getPasswordHash());
	}

	private function assertTogglesNotConflicting(bool $single, bool $freeform): void {
		if ($single && $freeform) {
			throw new ToggleConflictException('singleMode and freeformMode are mutually exclusive.');
		}
	}

	/**
	 * Build the curated `PlaylistEntry[]` for `createRoom`'s `initialEntries`
	 * argument. Validates uniqueness on `(providerId, videoId)`, applies
	 * the per-room cap, and assigns server-side `entryId` / `position` /
	 * `addedAt` / `lastSeenAt`. Caller is responsible for handing in
	 * already-trimmed strings; we don't massage URLs here.
	 *
	 * @param list<array{providerId: string, videoId: string, pageUrl: string, label?: string|null, episodeNumber?: int|null, seasonNumber?: int|null}> $candidates
	 * @return list<PlaylistEntry>
	 */
	private function buildInitialEntries(array $candidates, string $addedBy, int $now): array {
		if (count($candidates) > PlaylistService::PER_ROOM_CAP) {
			throw new PlaylistCapExceededException(
				PlaylistCapExceededException::CODE_PER_ROOM,
				'initialEntries exceeds per-room cap of ' . PlaylistService::PER_ROOM_CAP,
			);
		}

		$seen = [];
		$entries = [];
		$position = 1;
		foreach ($candidates as $candidate) {
			if (!isset($candidate['providerId'], $candidate['videoId'], $candidate['pageUrl'])) {
				throw new InvalidRoomInputException('initialEntries entries require providerId, videoId, pageUrl.');
			}
			$key = strtolower($candidate['providerId']) . '|' . strtolower($candidate['videoId']);
			if (isset($seen[$key])) {
				throw new InvalidRoomInputException('initialEntries contains duplicate (providerId, videoId).');
			}
			$seen[$key] = true;

			$entries[] = new PlaylistEntry(
				entryId: PlaylistEntry::generateEntryId(),
				position: $position++,
				providerId: $candidate['providerId'],
				videoId: $candidate['videoId'],
				pageUrl: $candidate['pageUrl'],
				label: $candidate['label'] ?? null,
				episodeNumber: $candidate['episodeNumber'] ?? null,
				seasonNumber: $candidate['seasonNumber'] ?? null,
				source: PlaylistEntry::SOURCE_CURATED,
				addedBy: $addedBy,
				addedAt: $now,
				lastSeenAt: $now,
			);
		}
		return $entries;
	}

	private function getDefaultTtlSeconds(int $maxTtl): int {
		$configured = $this->appConfig->getValueInt(Application::APP_ID, 'default_ttl_seconds', self::DEFAULT_TTL_SECONDS);
		if ($configured < 1 || $configured > $maxTtl) {
			return min(self::DEFAULT_TTL_SECONDS, $maxTtl);
		}
		return $configured;
	}

	private function getMaxTtlSeconds(): int {
		$configured = $this->appConfig->getValueInt(Application::APP_ID, 'max_ttl_seconds', self::MAX_TTL_SECONDS);
		// Negative or zero would brick room creation entirely; fall back to the safe default.
		if ($configured < 1) {
			return self::MAX_TTL_SECONDS;
		}
		return $configured;
	}

	private function isValidHttpUrl(string $url): bool {
		if (filter_var($url, FILTER_VALIDATE_URL) === false) {
			return false;
		}
		$scheme = parse_url($url, PHP_URL_SCHEME);
		return $scheme === 'http' || $scheme === 'https';
	}

	private function generatePassword(): string {
		$alphabetLen = strlen(self::PASSWORD_ALPHABET);
		$out = '';
		for ($i = 0; $i < self::PASSWORD_LENGTH; $i++) {
			$out .= self::PASSWORD_ALPHABET[random_int(0, $alphabetLen - 1)];
		}
		return $out;
	}

	private function generateUuidV4(): string {
		$bytes = random_bytes(16);
		$bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
		$bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
		$hex = bin2hex($bytes);
		return sprintf(
			'%s-%s-%s-%s-%s',
			substr($hex, 0, 8),
			substr($hex, 8, 4),
			substr($hex, 12, 4),
			substr($hex, 16, 4),
			substr($hex, 20, 12),
		);
	}
}
