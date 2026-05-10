<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\Exceptions\CreateRestrictedException;
use OCA\PlaybackSync\Service\Exceptions\InvalidRoomInputException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
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
	) {
	}

	public function assertCanCreate(string $userId): void {
		$restrict = $this->appConfig->getValueBool(Application::APP_ID, 'restrict_to_admins', false);
		if ($restrict && !$this->groupManager->isAdmin($userId)) {
			throw new CreateRestrictedException('Room creation is restricted to administrators.');
		}
	}

	/**
	 * @return array{room: Room, plainPassword: string}
	 */
	public function createRoom(string $userId, string $targetUrl, ?string $name, ?int $ttlSeconds): array {
		$this->assertCanCreate($userId);

		$targetUrl = trim($targetUrl);
		if ($targetUrl === '' || !$this->isValidHttpUrl($targetUrl)) {
			throw new InvalidRoomInputException('targetUrl must be a valid http(s) URL.');
		}

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
		$plainPassword = $this->generatePassword();

		$room = new Room();
		$room->setUuid($this->generateUuidV4());
		$room->setOwnerUserId($userId);
		$room->setName($name);
		$room->setTargetUrl($targetUrl);
		$room->setPasswordHash($this->hasher->hash($plainPassword));
		$room->setCreatedAt($nowMs);
		$room->setExpiresAt($nowMs + ($ttl * 1000));

		$room = $this->mapper->insert($room);

		return ['room' => $room, 'plainPassword' => $plainPassword];
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

	public function deleteOwnedRoom(string $userId, string $uuid): void {
		$room = $this->getOwnedRoom($userId, $uuid);
		$this->mapper->delete($room);
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
		$this->adminKickClient->kick($room->getUuid(), $clientId);
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
