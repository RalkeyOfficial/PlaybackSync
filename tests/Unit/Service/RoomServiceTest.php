<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\AdminKickClient;
use OCA\PlaybackSync\Service\AdminPlaybackClient;
use OCA\PlaybackSync\Service\Exceptions\ClientNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\CreateRestrictedException;
use OCA\PlaybackSync\Service\Exceptions\InvalidRoomInputException;
use OCA\PlaybackSync\Service\Exceptions\KickFailedException;
use OCA\PlaybackSync\Service\Exceptions\PlaybackCommandFailedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotLiveException;
use OCA\PlaybackSync\Service\RoomService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IAppConfig;
use OCP\IGroupManager;
use OCP\Security\IHasher;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class RoomServiceTest extends TestCase {

	private RoomMapper&MockObject $mapper;
	private IHasher&MockObject $hasher;
	private IAppConfig&MockObject $appConfig;
	private IGroupManager&MockObject $groupManager;
	private ITimeFactory&MockObject $timeFactory;
	private AdminKickClient&MockObject $adminKickClient;
	private AdminPlaybackClient&MockObject $adminPlaybackClient;
	private RoomService $service;

	private const FIXED_TIME_S = 1_700_000_000;
	private const FIXED_TIME_MS = 1_700_000_000_000;

	protected function setUp(): void {
		parent::setUp();
		$this->mapper = $this->createMock(RoomMapper::class);
		$this->hasher = $this->createMock(IHasher::class);
		$this->appConfig = $this->createMock(IAppConfig::class);
		$this->groupManager = $this->createMock(IGroupManager::class);
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->adminKickClient = $this->createMock(AdminKickClient::class);
		$this->adminPlaybackClient = $this->createMock(AdminPlaybackClient::class);

		$this->timeFactory->method('getTime')->willReturn(self::FIXED_TIME_S);

		// Defaults: not restricted, no admin override of TTL, hasher returns predictable shape.
		$this->appConfig->method('getValueBool')
			->with(Application::APP_ID, 'restrict_to_admins', false)
			->willReturn(false);
		$this->appConfig->method('getValueInt')
			->with(Application::APP_ID, 'default_ttl_seconds', RoomService::DEFAULT_TTL_SECONDS)
			->willReturn(RoomService::DEFAULT_TTL_SECONDS);
		$this->hasher->method('hash')->willReturnCallback(static fn (string $plain): string => 'hashed:' . $plain);

		// QBMapper::insert() returns the entity it was handed, so we mirror that.
		$this->mapper->method('insert')->willReturnArgument(0);

		$this->service = new RoomService(
			$this->mapper,
			$this->hasher,
			$this->appConfig,
			$this->groupManager,
			$this->timeFactory,
			$this->adminKickClient,
			$this->adminPlaybackClient,
		);
	}

	// ─── assertCanCreate ────────────────────────────────────────────────

	/**
	 * When `restrict_to_admins` is off, every logged-in user passes the gate and
	 * the service never even consults `IGroupManager::isAdmin()`. This guards
	 * against accidentally introducing an admin check that would break the
	 * default-open behaviour.
	 */
	public function testAssertCanCreateAllowsAnyUserWhenNotRestricted(): void {
		$this->groupManager->expects($this->never())->method('isAdmin');

		$this->service->assertCanCreate('alice');
		$this->addToAssertionCount(1);
	}

	/**
	 * With the restriction enabled, a user the group manager reports as an
	 * admin still passes the gate without exception.
	 */
	public function testAssertCanCreateAllowsAdminWhenRestricted(): void {
		$service = $this->buildServiceWithRestriction(true);
		$this->groupManager->method('isAdmin')->with('admin')->willReturn(true);

		$service->assertCanCreate('admin');
		$this->addToAssertionCount(1);
	}

	/**
	 * With the restriction enabled, a user the group manager reports as a
	 * non-admin is blocked with `CreateRestrictedException` — which the
	 * controller will translate into a 403.
	 */
	public function testAssertCanCreateThrowsForNonAdminWhenRestricted(): void {
		$service = $this->buildServiceWithRestriction(true);
		$this->groupManager->method('isAdmin')->with('alice')->willReturn(false);

		$this->expectException(CreateRestrictedException::class);
		$service->assertCanCreate('alice');
	}

	// ─── createRoom: happy path ─────────────────────────────────────────

	/**
	 * `createRoom` returns the contract documented in the API: an associative
	 * array with a `Room` entity and the plaintext password as a string.
	 */
	public function testCreateRoomReturnsRoomAndPlainPassword(): void {
		$result = $this->service->createRoom('alice', 'https://example.com/watch', 'Friday', 3600);

		$this->assertArrayHasKey('room', $result);
		$this->assertArrayHasKey('plainPassword', $result);
		$this->assertInstanceOf(Room::class, $result['room']);
		$this->assertIsString($result['plainPassword']);
	}

	/**
	 * The generated password is exactly 16 characters from the
	 * [A-Za-z0-9] alphabet — the contract the API documentation promises.
	 */
	public function testCreateRoomGeneratesSixteenCharAlphanumericPassword(): void {
		$result = $this->service->createRoom('alice', 'https://example.com/watch', null, null);

		$this->assertSame(RoomService::PASSWORD_LENGTH, strlen($result['plainPassword']));
		$this->assertMatchesRegularExpression('/^[A-Za-z0-9]{16}$/', $result['plainPassword']);
	}

	/**
	 * The generated UUID matches the canonical v4 format including the version
	 * nibble (`4`) and the variant nibble (`8`/`9`/`a`/`b`).
	 */
	public function testCreateRoomGeneratesValidUuidV4(): void {
		$result = $this->service->createRoom('alice', 'https://example.com/watch', null, null);

		$this->assertMatchesRegularExpression(
			'/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
			$result['room']->getUuid(),
		);
	}

	/**
	 * The plaintext password is funnelled through `IHasher::hash()` exactly
	 * once and the resulting hash is what gets stored on the entity. The
	 * plaintext itself is never written to the entity.
	 */
	public function testCreateRoomHashesPasswordThroughIHasher(): void {
		$this->hasher->expects($this->once())->method('hash');

		$result = $this->service->createRoom('alice', 'https://example.com/watch', null, null);

		// setUp's hasher mock prefixes the plaintext with "hashed:".
		$this->assertSame('hashed:' . $result['plainPassword'], $result['room']->getPasswordHash());
	}

	/**
	 * The new room actually reaches the database via the mapper. This catches
	 * the regression where a refactor accidentally drops the persistence call.
	 */
	public function testCreateRoomPersistsThroughMapper(): void {
		$this->mapper->expects($this->once())->method('insert')->with($this->isInstanceOf(Room::class));

		$this->service->createRoom('alice', 'https://example.com/watch', null, null);
	}

	/**
	 * `owner_user_id`, `created_at`, and `expires_at` are populated in
	 * milliseconds (not seconds) and `expires_at = created_at + ttl * 1000`.
	 */
	public function testCreateRoomSetsOwnerAndTimestampsInMilliseconds(): void {
		$result = $this->service->createRoom('alice', 'https://example.com/watch', null, 3600);
		$room = $result['room'];

		$this->assertSame('alice', $room->getOwnerUserId());
		$this->assertSame(self::FIXED_TIME_MS, $room->getCreatedAt());
		$this->assertSame(self::FIXED_TIME_MS + 3600 * 1000, $room->getExpiresAt());
	}

	/**
	 * If the caller omits `ttl`, the service falls back to the configured
	 * `default_ttl_seconds` (24 hours by default).
	 */
	public function testCreateRoomDefaultsTtlToConfiguredValueWhenNotProvided(): void {
		$result = $this->service->createRoom('alice', 'https://example.com/watch', null, null);

		$expectedExpiry = self::FIXED_TIME_MS + (RoomService::DEFAULT_TTL_SECONDS * 1000);
		$this->assertSame($expectedExpiry, $result['room']->getExpiresAt());
	}

	/**
	 * If an admin sets a nonsensical `default_ttl_seconds` (zero, negative,
	 * or larger than the hard maximum) the service silently ignores it and
	 * uses the safe default. Misconfiguration must not break the create flow.
	 */
	public function testCreateRoomFallsBackToDefaultTtlWhenAdminConfiguredOutOfRange(): void {
		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getValueBool')->willReturn(false);
		$appConfig->method('getValueInt')->willReturn(99_999_999); // way over MAX_TTL
		$service = $this->rebuildWith($appConfig);

		$result = $service->createRoom('alice', 'https://example.com/watch', null, null);

		$expectedExpiry = self::FIXED_TIME_MS + (RoomService::DEFAULT_TTL_SECONDS * 1000);
		$this->assertSame($expectedExpiry, $result['room']->getExpiresAt());
	}

	// ─── createRoom: targetUrl validation ───────────────────────────────

	public static function invalidUrlsProvider(): array {
		return [
			'empty string' => [''],
			'whitespace only' => ['   '],
			'not a URL' => ['not-a-url'],
			'ftp scheme' => ['ftp://example.com/watch'],
			'file scheme' => ['file:///etc/passwd'],
			'javascript scheme' => ['javascript:alert(1)'],
		];
	}

	/**
	 * Anything that isn't an `http://` or `https://` URL is rejected with
	 * `InvalidRoomInputException`. This protects participants from being
	 * redirected to dangerous schemes (`javascript:`, `file://`, etc.) and
	 * keeps the share-link contract simple.
	 */
	#[DataProvider('invalidUrlsProvider')]
	public function testCreateRoomRejectsInvalidTargetUrl(string $url): void {
		$this->expectException(InvalidRoomInputException::class);
		$this->service->createRoom('alice', $url, null, null);
	}

	public static function validUrlsProvider(): array {
		return [
			'http' => ['http://example.com/'],
			'https' => ['https://example.com/watch?ep=1'],
			'with port' => ['https://example.com:8443/watch'],
		];
	}

	/**
	 * Plain `http://`, `https://`, and `https://...:port` URLs all pass
	 * validation and are stored on the entity verbatim (no normalization).
	 */
	#[DataProvider('validUrlsProvider')]
	public function testCreateRoomAcceptsValidHttpUrls(string $url): void {
		$result = $this->service->createRoom('alice', $url, null, null);
		$this->assertSame($url, $result['room']->getTargetUrl());
	}

	// ─── createRoom: name validation ────────────────────────────────────

	/**
	 * Names longer than 100 characters are rejected. The 100-char limit
	 * matches the column width in the migration.
	 */
	public function testCreateRoomRejectsNameOverHundredChars(): void {
		$this->expectException(InvalidRoomInputException::class);
		$this->service->createRoom('alice', 'https://example.com/', str_repeat('a', 101), null);
	}

	/**
	 * Boundary: a name of exactly 100 characters is allowed and stored as-is.
	 * This guards against off-by-one regressions in the length check.
	 */
	public function testCreateRoomAcceptsNameAtExactlyHundredChars(): void {
		$name = str_repeat('a', 100);
		$result = $this->service->createRoom('alice', 'https://example.com/', $name, null);
		$this->assertSame($name, $result['room']->getName());
	}

	/**
	 * An empty-string name is treated as "no name" and stored as `null`,
	 * not as an empty string. This keeps the DB clean and the UI honest.
	 */
	public function testCreateRoomNormalizesEmptyNameToNull(): void {
		$result = $this->service->createRoom('alice', 'https://example.com/', '', null);
		$this->assertNull($result['room']->getName());
	}

	/**
	 * Whitespace-only names are also normalized to `null`, so a user typing
	 * spaces into the name field doesn't end up with a blank-looking room.
	 */
	public function testCreateRoomNormalizesWhitespaceNameToNull(): void {
		$result = $this->service->createRoom('alice', 'https://example.com/', '   ', null);
		$this->assertNull($result['room']->getName());
	}

	/**
	 * Names with leading/trailing whitespace are trimmed before storage.
	 * Users get back the value they meant, not the value they typed.
	 */
	public function testCreateRoomTrimsNameWhitespace(): void {
		$result = $this->service->createRoom('alice', 'https://example.com/', '  Friday  ', null);
		$this->assertSame('Friday', $result['room']->getName());
	}

	// ─── createRoom: ttl validation ─────────────────────────────────────

	public static function outOfRangeTtlsProvider(): array {
		return [
			'zero' => [0],
			'negative' => [-1],
			'over max' => [RoomService::MAX_TTL_SECONDS + 1],
		];
	}

	/**
	 * Caller-supplied `ttl` values outside `[1, MAX_TTL_SECONDS]` are
	 * rejected with `InvalidRoomInputException`. The 24-hour cap is a
	 * deliberate product decision and must hold at the service boundary.
	 */
	#[DataProvider('outOfRangeTtlsProvider')]
	public function testCreateRoomRejectsTtlOutOfRange(int $ttl): void {
		$this->expectException(InvalidRoomInputException::class);
		$this->service->createRoom('alice', 'https://example.com/', null, $ttl);
	}

	public static function inRangeTtlsProvider(): array {
		return [
			'minimum' => [1],
			'middle' => [3600],
			'maximum' => [RoomService::MAX_TTL_SECONDS],
		];
	}

	/**
	 * Boundary check: ttl of 1, a typical value, and the exact maximum all
	 * succeed and produce the expected `expires_at` in milliseconds.
	 */
	#[DataProvider('inRangeTtlsProvider')]
	public function testCreateRoomAcceptsTtlAtBoundaries(int $ttl): void {
		$result = $this->service->createRoom('alice', 'https://example.com/', null, $ttl);
		$this->assertSame(self::FIXED_TIME_MS + $ttl * 1000, $result['room']->getExpiresAt());
	}

	// ─── createRoom: admin gate ─────────────────────────────────────────

	/**
	 * When the admin restriction is on, a non-admin trying to create gets
	 * blocked *before* any DB call. The combined effect with the controller
	 * is a 403 with a friendly message.
	 */
	public function testCreateRoomThrowsCreateRestrictedForNonAdminWhenRestricted(): void {
		$service = $this->buildServiceWithRestriction(true);
		$this->groupManager->method('isAdmin')->with('alice')->willReturn(false);

		$this->expectException(CreateRestrictedException::class);
		$service->createRoom('alice', 'https://example.com/', null, null);
	}

	/**
	 * Mirror of the rejection test: with the restriction on, an admin can
	 * still create rooms, and the resulting row is owned by the admin user.
	 */
	public function testCreateRoomAllowsAdminWhenRestricted(): void {
		$service = $this->buildServiceWithRestriction(true);
		$this->groupManager->method('isAdmin')->with('admin')->willReturn(true);

		$result = $service->createRoom('admin', 'https://example.com/', null, null);
		$this->assertSame('admin', $result['room']->getOwnerUserId());
	}

	// ─── listForOwner ────────────────────────────────────────────────────

	/**
	 * `listForOwner` is a thin pass-through to `RoomMapper::findActiveByOwner`,
	 * forwarding the user id and the *current* time in milliseconds. The
	 * mapper does the actual filtering by ownership and expiry.
	 */
	public function testListForOwnerDelegatesToMapperWithCurrentMillis(): void {
		$expectedRooms = [new Room(), new Room()];
		$this->mapper->expects($this->once())
			->method('findActiveByOwner')
			->with('alice', self::FIXED_TIME_MS)
			->willReturn($expectedRooms);

		$result = $this->service->listForOwner('alice');
		$this->assertSame($expectedRooms, $result);
	}

	// ─── getOwnedRoom ────────────────────────────────────────────────────

	/**
	 * Happy path: the UUID exists, the caller owns it, and it hasn't expired,
	 * so the entity is returned untouched.
	 */
	public function testGetOwnedRoomReturnsRoomWhenOwnerMatchesAndActive(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->with('uuid-1')->willReturn($room);

		$result = $this->service->getOwnedRoom('alice', 'uuid-1');
		$this->assertSame($room, $result);
	}

	/**
	 * Unknown UUIDs surface as `RoomNotFoundException`. The mapper's
	 * `DoesNotExistException` is caught and rewrapped so HTTP-layer code
	 * never has to import Nextcloud's DB exception type.
	 */
	public function testGetOwnedRoomThrowsNotFoundWhenUuidUnknown(): void {
		$this->mapper->method('findByUuid')->with('missing')->willThrowException(new DoesNotExistException('nope'));

		$this->expectException(RoomNotFoundException::class);
		$this->service->getOwnedRoom('alice', 'missing');
	}

	/**
	 * Cross-user lookups also produce `RoomNotFoundException`, deliberately
	 * collapsing into the same surface as "doesn't exist". This is the
	 * privacy property that an attacker cannot probe UUIDs to detect rooms
	 * belonging to other users.
	 */
	public function testGetOwnedRoomThrowsNotFoundWhenOwnerDoesNotMatch(): void {
		$room = $this->makeRoom('bob', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);

		$this->expectException(RoomNotFoundException::class);
		$this->service->getOwnedRoom('alice', 'uuid-1');
	}

	/**
	 * Expired rooms are also returned as 404, even if the caller owns them
	 * and the row is still physically present (prune job hasn't run yet).
	 */
	public function testGetOwnedRoomThrowsNotFoundWhenExpired(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: -1);
		$this->mapper->method('findByUuid')->willReturn($room);

		$this->expectException(RoomNotFoundException::class);
		$this->service->getOwnedRoom('alice', 'uuid-1');
	}

	// ─── deleteOwnedRoom ────────────────────────────────────────────────

	/**
	 * Owner-initiated delete: `getOwnedRoom` finds the row, then the mapper's
	 * delete is called exactly once with that entity.
	 */
	public function testDeleteOwnedRoomDeletesViaMapperWhenOwnerMatches(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->mapper->expects($this->once())->method('delete')->with($room);

		$this->service->deleteOwnedRoom('alice', 'uuid-1');
	}

	/**
	 * Cross-user delete attempts are blocked with `RoomNotFoundException`
	 * *before* any DB delete runs. The expectation `$this->never()` guards
	 * against any future refactor accidentally letting the call through.
	 */
	public function testDeleteOwnedRoomThrowsNotFoundForCrossUser(): void {
		$room = $this->makeRoom('bob', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->mapper->expects($this->never())->method('delete');

		$this->expectException(RoomNotFoundException::class);
		$this->service->deleteOwnedRoom('alice', 'uuid-1');
	}

	// ─── kickClient ─────────────────────────────────────────────────────

	/**
	 * Owner-initiated kick: ownership is verified through `getOwnedRoom`, then
	 * the admin loopback client is invoked once with the room's UUID and the
	 * supplied client id.
	 */
	public function testKickClientForwardsToAdminClientWhenOwnerMatches(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->adminKickClient->expects($this->once())
			->method('kick')
			->with('uuid-1', 'deadbeef');

		$this->service->kickClient('alice', 'uuid-1', 'deadbeef');
	}

	/**
	 * Cross-user kick attempts are blocked with `RoomNotFoundException`
	 * *before* the admin client is consulted — preserving the same opacity
	 * contract as `deleteOwnedRoom`.
	 */
	public function testKickClientThrowsNotFoundForCrossUser(): void {
		$room = $this->makeRoom('bob', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->adminKickClient->expects($this->never())->method('kick');

		$this->expectException(RoomNotFoundException::class);
		$this->service->kickClient('alice', 'uuid-1', 'deadbeef');
	}

	/**
	 * `ClientNotFoundException` from the admin client is propagated unchanged
	 * so the controller can map it to a 404 distinct from "room not found".
	 */
	public function testKickClientPropagatesClientNotFoundException(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->adminKickClient->method('kick')
			->willThrowException(new ClientNotFoundException('not connected'));

		$this->expectException(ClientNotFoundException::class);
		$this->service->kickClient('alice', 'uuid-1', 'deadbeef');
	}

	/**
	 * `KickFailedException` from the admin client (daemon down, HMAC misconfig,
	 * unexpected status) is propagated unchanged so the controller can map it
	 * to a 502 — operators see the difference between "daemon broken" and
	 * "client wasn't there".
	 */
	public function testKickClientPropagatesKickFailedException(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->adminKickClient->method('kick')
			->willThrowException(new KickFailedException('daemon unreachable'));

		$this->expectException(KickFailedException::class);
		$this->service->kickClient('alice', 'uuid-1', 'deadbeef');
	}

	// ─── sendPlaybackCommand ────────────────────────────────────────────

	/**
	 * Owner-initiated playback command: ownership is verified through
	 * `getOwnedRoom`, then the admin loopback client is invoked once with the
	 * room's UUID, action, and (for seek) the position.
	 */
	public function testSendPlaybackCommandForwardsToAdminClientWhenOwnerMatches(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->adminPlaybackClient->expects($this->once())
			->method('apply')
			->with('uuid-1', 'seek', 42.0);

		$this->service->sendPlaybackCommand('alice', 'uuid-1', 'seek', 42.0);
	}

	public function testSendPlaybackCommandThrowsNotFoundForCrossUser(): void {
		$room = $this->makeRoom('bob', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->adminPlaybackClient->expects($this->never())->method('apply');

		$this->expectException(RoomNotFoundException::class);
		$this->service->sendPlaybackCommand('alice', 'uuid-1', 'play', null);
	}

	public function testSendPlaybackCommandPropagatesRoomNotLiveException(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->adminPlaybackClient->method('apply')
			->willThrowException(new RoomNotLiveException('no clients'));

		$this->expectException(RoomNotLiveException::class);
		$this->service->sendPlaybackCommand('alice', 'uuid-1', 'play', null);
	}

	public function testSendPlaybackCommandPropagatesPlaybackCommandFailedException(): void {
		$room = $this->makeRoom('alice', expiresInSeconds: 3600);
		$this->mapper->method('findByUuid')->willReturn($room);
		$this->adminPlaybackClient->method('apply')
			->willThrowException(new PlaybackCommandFailedException('daemon unreachable'));

		$this->expectException(PlaybackCommandFailedException::class);
		$this->service->sendPlaybackCommand('alice', 'uuid-1', 'pause', null);
	}

	// ─── helpers ────────────────────────────────────────────────────────

	private function buildServiceWithRestriction(bool $restricted): RoomService {
		$appConfig = $this->createMock(IAppConfig::class);
		$appConfig->method('getValueBool')
			->with(Application::APP_ID, 'restrict_to_admins', false)
			->willReturn($restricted);
		$appConfig->method('getValueInt')->willReturn(RoomService::DEFAULT_TTL_SECONDS);
		return $this->rebuildWith($appConfig);
	}

	private function rebuildWith(IAppConfig $appConfig): RoomService {
		return new RoomService(
			$this->mapper,
			$this->hasher,
			$appConfig,
			$this->groupManager,
			$this->timeFactory,
			$this->adminKickClient,
			$this->adminPlaybackClient,
		);
	}

	private function makeRoom(string $owner, int $expiresInSeconds): Room {
		$room = new Room();
		$room->setUuid('uuid-1');
		$room->setOwnerUserId($owner);
		$room->setExpiresAt(self::FIXED_TIME_MS + $expiresInSeconds * 1000);
		return $room;
	}
}
