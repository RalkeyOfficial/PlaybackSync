<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Controller\ShareController;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\RoomService;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\RedirectResponse;
use OCP\IRequest;
use OCP\IURLGenerator;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class ShareControllerTest extends TestCase {

	private const UUID = '5a66524f-5ba1-4f3d-8897-7c5838c0bd80';
	private const PASSWORD = 'UIjND2muufTfrrel';

	private IRequest&MockObject $request;
	private RoomService&MockObject $rooms;
	private IURLGenerator&MockObject $urlGenerator;
	private ShareController $controller;

	protected function setUp(): void {
		parent::setUp();
		$this->request = $this->createMock(IRequest::class);
		$this->rooms = $this->createMock(RoomService::class);
		$this->urlGenerator = $this->createMock(IURLGenerator::class);
		$this->urlGenerator->method('getAbsoluteURL')
			->willReturnCallback(static fn (string $path): string => 'https://cloud.example' . $path);

		$this->controller = new ShareController(
			Application::APP_ID,
			$this->request,
			$this->rooms,
			$this->urlGenerator,
		);
	}

	private function makeRoom(string $bootstrapUrl = 'https://video.example/watch'): Room {
		$room = new Room();
		$room->setUuid(self::UUID);
		$room->setOwnerUserId('alice');
		$room->setBootstrapUrl($bootstrapUrl);
		$room->setPasswordHash('$argon2id$v=19$m=...$hashbytes');
		$room->setCreatedAt(1_700_000_000_000);
		$room->setExpiresAt(1_700_000_900_000);
		return $room;
	}

	private function withAuthHeader(string $value): void {
		$this->request->method('getHeader')->willReturnCallback(
			static fn (string $name): string => strtolower($name) === 'authorization' ? $value : ''
		);
	}

	private static function basic(string $user, string $pass): string {
		return 'Basic ' . base64_encode($user . ':' . $pass);
	}

	// ─── 404 surface ─────────────────────────────────────────────────────

	public function testUnknownUuidReturns404(): void {
		$this->rooms->method('getActiveRoom')->willThrowException(new RoomNotFoundException('Room not found.'));

		$response = $this->controller->show(self::UUID);

		$this->assertInstanceOf(DataResponse::class, $response);
		$this->assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
		$this->assertSame(['error' => 'not_found'], $response->getData());
		$this->assertArrayNotHasKey('WWW-Authenticate', $response->getHeaders());
	}

	public function testExpiredRoomReturnsSame404Surface(): void {
		// `getActiveRoom` collapses expired and unknown into the same exception,
		// so the controller can't tell them apart — verifying the 404 body and
		// absence of WWW-Authenticate is the strongest assertion we can make
		// here, and it's exactly the privacy property we want.
		$this->rooms->method('getActiveRoom')->willThrowException(new RoomNotFoundException('Room not found.'));

		$response = $this->controller->show(self::UUID);

		$this->assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
		$this->assertSame(['error' => 'not_found'], $response->getData());
		$this->assertArrayNotHasKey('WWW-Authenticate', $response->getHeaders());
		$this->assertFalse($response->isThrottled());
	}

	// ─── 401: missing / malformed auth — NOT throttled ───────────────────

	public function testMissingAuthorizationHeaderReturns401WithChallengeAndIsNotThrottled(): void {
		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom());
		$this->request->method('getHeader')->willReturn('');

		$response = $this->controller->show(self::UUID);

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
		$this->assertSame(
			'Basic realm="Room ' . self::UUID . '"',
			$response->getHeaders()['WWW-Authenticate'] ?? null,
		);
		$this->assertFalse($response->isThrottled());
	}

	public function testNonBasicSchemeReturns401NotThrottled(): void {
		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom());
		$this->withAuthHeader('Bearer some-token');

		$response = $this->controller->show(self::UUID);

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
		$this->assertFalse($response->isThrottled());
	}

	public function testMalformedBasicHeaderReturns401NotThrottled(): void {
		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom());
		// "Basic " followed by something that is neither valid base64 nor
		// contains a colon after decoding.
		$this->withAuthHeader('Basic !!!notbase64!!!');

		$response = $this->controller->show(self::UUID);

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
		$this->assertFalse($response->isThrottled());
	}

	public function testBasicHeaderWithNoColonReturns401NotThrottled(): void {
		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom());
		// Decodes to "noseparator" — no colon, so explode returns one element.
		$this->withAuthHeader('Basic ' . base64_encode('noseparator'));

		$response = $this->controller->show(self::UUID);

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
		$this->assertFalse($response->isThrottled());
	}

	// ─── 401: wrong password — IS throttled ──────────────────────────────

	public function testWrongPasswordReturns401AndIsThrottledWithAction(): void {
		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom());
		$this->rooms->method('verifyPassword')->willReturn(false);
		$this->withAuthHeader(self::basic('', 'wrong-password'));

		$response = $this->controller->show(self::UUID);

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
		$this->assertSame(
			'Basic realm="Room ' . self::UUID . '"',
			$response->getHeaders()['WWW-Authenticate'] ?? null,
		);
		$this->assertTrue($response->isThrottled());
		$this->assertSame(['action' => 'playbacksync_share'], $response->getThrottleMetadata());
	}

	// ─── 302: success cases ──────────────────────────────────────────────

	public function testValidPasswordRedirectsWithSyncParamsOnSimpleTarget(): void {
		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom('https://video.example/watch'));
		$this->rooms->method('verifyPassword')->willReturn(true);
		$this->withAuthHeader(self::basic('', self::PASSWORD));

		$response = $this->controller->show(self::UUID);

		$this->assertInstanceOf(RedirectResponse::class, $response);
		$this->assertSame(Http::STATUS_FOUND, $response->getStatus());

		$location = $response->getRedirectURL();
		$this->assertStringStartsWith('https://video.example/watch?', $location);

		$query = $this->queryOf($location);
		$this->assertSame(
			'wss://cloud.example/apps/playbacksync/ws/' . self::UUID,
			$query['sync_url'] ?? null,
		);
		$this->assertSame(self::PASSWORD, $query['sync_password'] ?? null);
	}

	public function testRedirectMergesIntoExistingTargetQuery(): void {
		$this->rooms->method('getActiveRoom')->willReturn(
			$this->makeRoom('https://video.example/watch?v=abc&t=10'),
		);
		$this->rooms->method('verifyPassword')->willReturn(true);
		$this->withAuthHeader(self::basic('', self::PASSWORD));

		$response = $this->controller->show(self::UUID);
		$query = $this->queryOf($response->getRedirectURL());

		$this->assertSame('abc', $query['v'] ?? null);
		$this->assertSame('10', $query['t'] ?? null);
		$this->assertSame(
			'wss://cloud.example/apps/playbacksync/ws/' . self::UUID,
			$query['sync_url'] ?? null,
		);
		$this->assertSame(self::PASSWORD, $query['sync_password'] ?? null);
	}

	public function testRedirectPreservesFragment(): void {
		$this->rooms->method('getActiveRoom')->willReturn(
			$this->makeRoom('https://video.example/watch#chap1'),
		);
		$this->rooms->method('verifyPassword')->willReturn(true);
		$this->withAuthHeader(self::basic('', self::PASSWORD));

		$response = $this->controller->show(self::UUID);
		$location = $response->getRedirectURL();

		$this->assertStringEndsWith('#chap1', $location);
		// Fragment must come after the merged query, not get clobbered by it.
		$this->assertMatchesRegularExpression('~\?[^#]+#chap1$~', $location);
	}

	public function testHttpUrlGeneratorYieldsWsScheme(): void {
		$urlGenerator = $this->createMock(IURLGenerator::class);
		$urlGenerator->method('getAbsoluteURL')
			->willReturnCallback(static fn (string $path): string => 'http://cloud.example' . $path);
		$controller = new ShareController(Application::APP_ID, $this->request, $this->rooms, $urlGenerator);

		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom('https://video.example/watch'));
		$this->rooms->method('verifyPassword')->willReturn(true);
		$this->withAuthHeader(self::basic('', self::PASSWORD));

		$response = $controller->show(self::UUID);
		$query = $this->queryOf($response->getRedirectURL());

		$this->assertSame(
			'ws://cloud.example/apps/playbacksync/ws/' . self::UUID,
			$query['sync_url'] ?? null,
		);
	}

	public function testPasswordContainingColonRoundTrips(): void {
		$pwd = 'foo:bar:baz';
		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom());
		// `verifyPassword` must receive the full password including colons.
		$this->rooms->expects($this->once())
			->method('verifyPassword')
			->with($this->anything(), $pwd)
			->willReturn(true);
		$this->withAuthHeader(self::basic('', $pwd));

		$response = $this->controller->show(self::UUID);
		$query = $this->queryOf($response->getRedirectURL());

		$this->assertSame($pwd, $query['sync_password'] ?? null);
	}

	public function testUsernameInBasicAuthIsIgnored(): void {
		$this->rooms->method('getActiveRoom')->willReturn($this->makeRoom());
		$this->rooms->expects($this->once())
			->method('verifyPassword')
			->with($this->anything(), self::PASSWORD)
			->willReturn(true);
		// Username "joe" present but the controller should validate the
		// password only.
		$this->withAuthHeader(self::basic('joe', self::PASSWORD));

		$response = $this->controller->show(self::UUID);

		$this->assertInstanceOf(RedirectResponse::class, $response);
		$this->assertSame(Http::STATUS_FOUND, $response->getStatus());
	}

	/**
	 * Parse the query string out of a URL into an associative array.
	 *
	 * @return array<string, string>
	 */
	private function queryOf(string $url): array {
		$queryString = parse_url($url, PHP_URL_QUERY);
		if (!is_string($queryString)) {
			return [];
		}
		$out = [];
		parse_str($queryString, $out);
		/** @var array<string, string> $out */
		return $out;
	}
}
