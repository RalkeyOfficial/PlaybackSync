<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Controller;

use OCA\PlaybackSync\Controller\RoomController;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Service\Exceptions\CreateRestrictedException;
use OCA\PlaybackSync\Service\Exceptions\InvalidRoomInputException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\RoomService;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IURLGenerator;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class RoomControllerTest extends TestCase {

	private IRequest&MockObject $request;
	private RoomService&MockObject $service;
	private IURLGenerator&MockObject $urlGenerator;

	protected function setUp(): void {
		parent::setUp();
		$this->request = $this->createMock(IRequest::class);
		$this->service = $this->createMock(RoomService::class);
		$this->urlGenerator = $this->createMock(IURLGenerator::class);
		$this->urlGenerator->method('getAbsoluteURL')
			->willReturnCallback(static fn (string $path): string => 'https://nc.test' . $path);
	}

	private function controller(?string $userId): RoomController {
		return new RoomController('playbacksync', $this->request, $userId, $this->service, $this->urlGenerator);
	}

	private function makeRoom(string $owner = 'alice'): Room {
		$room = new Room();
		$room->setUuid('uuid-1');
		$room->setOwnerUserId($owner);
		$room->setName('Friday');
		$room->setTargetUrl('https://example.com/watch');
		$room->setCreatedAt(1_700_000_000_000);
		$room->setExpiresAt(1_700_000_900_000);
		return $room;
	}

	// ─── 401 guard ───────────────────────────────────────────────────────

	/**
	 * `index` must short-circuit with 401 when the request is unauthenticated
	 * (`$userId === null`), before touching the service. The body carries
	 * the friendly `Authentication required.` message documented in api.md.
	 */
	public function testIndexReturns401WhenNotLoggedIn(): void {
		$response = $this->controller(null)->index();

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
		$this->assertSame(['error' => 'Authentication required.'], $response->getData());
	}

	/**
	 * `show` mirrors `index`'s 401 behaviour for unauthenticated callers.
	 */
	public function testShowReturns401WhenNotLoggedIn(): void {
		$response = $this->controller(null)->show('uuid-1');
		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
	}

	/**
	 * `create` mirrors the same 401 short-circuit so we never call into
	 * the service with a null user id.
	 */
	public function testCreateReturns401WhenNotLoggedIn(): void {
		$response = $this->controller(null)->create('https://example.com/');
		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
	}

	/**
	 * `destroy` mirrors the same 401 short-circuit.
	 */
	public function testDestroyReturns401WhenNotLoggedIn(): void {
		$response = $this->controller(null)->destroy('uuid-1');
		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
	}

	// ─── index ────────────────────────────────────────────────────────────

	/**
	 * Happy path: `index` returns 200 with `{rooms: [...]}` and each room is
	 * serialized through `serializeRoom`. Critically, the password field is
	 * never present on list responses — that would mean leaking hashes.
	 */
	public function testIndexReturnsSerializedRooms(): void {
		$this->service->method('listForOwner')->with('alice')->willReturn([$this->makeRoom()]);

		$response = $this->controller('alice')->index();

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$payload = $response->getData();
		$this->assertArrayHasKey('rooms', $payload);
		$this->assertCount(1, $payload['rooms']);
		$this->assertSame('uuid-1', $payload['rooms'][0]['uuid']);
		$this->assertArrayNotHasKey('password', $payload['rooms'][0]);
	}

	/**
	 * Empty list state still returns 200 with an empty `rooms` array, not
	 * 404 or `null`. This is what the frontend's `loaded` flag relies on.
	 */
	public function testIndexReturnsEmptyArrayWhenNoRooms(): void {
		$this->service->method('listForOwner')->willReturn([]);

		$response = $this->controller('alice')->index();

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertSame(['rooms' => []], $response->getData());
	}

	// ─── show ────────────────────────────────────────────────────────────

	/**
	 * Happy path: `show` forwards the (userId, uuid) pair to the service
	 * and returns the serialized room with no password leak.
	 */
	public function testShowReturnsRoomWhenFound(): void {
		$this->service->method('getOwnedRoom')->with('alice', 'uuid-1')->willReturn($this->makeRoom());

		$response = $this->controller('alice')->show('uuid-1');

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertSame('uuid-1', $response->getData()['uuid']);
		$this->assertArrayNotHasKey('password', $response->getData());
	}

	/**
	 * `RoomNotFoundException` from the service maps to HTTP 404 and the
	 * exception's message is forwarded verbatim as the JSON `error` field.
	 */
	public function testShowReturns404WhenServiceThrowsNotFound(): void {
		$this->service->method('getOwnedRoom')->willThrowException(new RoomNotFoundException('Room not found.'));

		$response = $this->controller('alice')->show('missing');

		$this->assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
		$this->assertSame(['error' => 'Room not found.'], $response->getData());
	}

	// ─── create ──────────────────────────────────────────────────────────

	/**
	 * Happy path: `create` forwards the form fields to the service and
	 * returns 201 with the room *and* the plaintext password attached. This
	 * is the only response in the entire API where `password` is present.
	 */
	public function testCreateReturns201WithPasswordOnSuccess(): void {
		$this->service->method('createRoom')
			->with('alice', 'https://example.com/', 'Friday', 3600)
			->willReturn(['room' => $this->makeRoom(), 'plainPassword' => 'plain-pw-16chars']);

		$response = $this->controller('alice')->create('https://example.com/', 'Friday', 3600);

		$this->assertSame(Http::STATUS_CREATED, $response->getStatus());
		$payload = $response->getData();
		$this->assertSame('uuid-1', $payload['uuid']);
		$this->assertSame('plain-pw-16chars', $payload['password']);
	}

	/**
	 * `InvalidRoomInputException` from the service maps to 400 with the
	 * message forwarded verbatim — the validation messages are designed
	 * to be safely user-facing.
	 */
	public function testCreateReturns400OnInvalidInput(): void {
		$this->service->method('createRoom')->willThrowException(new InvalidRoomInputException('targetUrl must be a valid http(s) URL.'));

		$response = $this->controller('alice')->create('bogus');

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
		$this->assertSame(['error' => 'targetUrl must be a valid http(s) URL.'], $response->getData());
	}

	/**
	 * `CreateRestrictedException` (admin-only mode + non-admin caller)
	 * maps to 403 with the user-facing message. This is the only place
	 * 403 ever comes out of the API.
	 */
	public function testCreateReturns403WhenRestricted(): void {
		$this->service->method('createRoom')->willThrowException(new CreateRestrictedException('Room creation is restricted to administrators.'));

		$response = $this->controller('alice')->create('https://example.com/');

		$this->assertSame(Http::STATUS_FORBIDDEN, $response->getStatus());
		$this->assertSame(['error' => 'Room creation is restricted to administrators.'], $response->getData());
	}

	/**
	 * The `shareLink` field is built from `IURLGenerator::getAbsoluteURL`
	 * with the future-public `/index.php/apps/playbacksync/r/{uuid}` path.
	 * If this format ever drifts, the share link in the UI silently breaks.
	 */
	public function testCreateIncludesShareLinkBuiltFromUrlGenerator(): void {
		$this->service->method('createRoom')
			->willReturn(['room' => $this->makeRoom(), 'plainPassword' => 'plain-pw-16chars']);

		$response = $this->controller('alice')->create('https://example.com/');

		$this->assertSame(
			'https://nc.test/index.php/apps/playbacksync/r/uuid-1',
			$response->getData()['shareLink'],
		);
	}

	// ─── destroy ─────────────────────────────────────────────────────────

	/**
	 * Happy path: `destroy` calls `RoomService::deleteOwnedRoom` once and
	 * returns 204 with a null body — REST convention for "deleted".
	 */
	public function testDestroyReturns204OnSuccess(): void {
		$this->service->expects($this->once())->method('deleteOwnedRoom')->with('alice', 'uuid-1');

		$response = $this->controller('alice')->destroy('uuid-1');

		$this->assertSame(Http::STATUS_NO_CONTENT, $response->getStatus());
		$this->assertNull($response->getData());
	}

	/**
	 * `RoomNotFoundException` raised during delete maps to 404 — same
	 * collapsed surface as show, so attackers can't probe by deletion.
	 */
	public function testDestroyReturns404WhenServiceThrowsNotFound(): void {
		$this->service->method('deleteOwnedRoom')->willThrowException(new RoomNotFoundException('Room not found.'));

		$response = $this->controller('alice')->destroy('missing');

		$this->assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
		$this->assertSame(['error' => 'Room not found.'], $response->getData());
	}

	// ─── DataResponse sanity ──────────────────────────────────────────────

	/**
	 * Belt-and-braces: every endpoint returns a `DataResponse`, not a
	 * `JSONResponse` or anything else. A regression here would change the
	 * wire format in subtle ways (different default headers, etc.).
	 */
	public function testEveryEndpointReturnsDataResponse(): void {
		$this->service->method('listForOwner')->willReturn([]);
		$this->service->method('getOwnedRoom')->willReturn($this->makeRoom());
		$this->service->method('createRoom')->willReturn(['room' => $this->makeRoom(), 'plainPassword' => 'x']);

		$controller = $this->controller('alice');
		$this->assertInstanceOf(DataResponse::class, $controller->index());
		$this->assertInstanceOf(DataResponse::class, $controller->show('uuid-1'));
		$this->assertInstanceOf(DataResponse::class, $controller->create('https://example.com/'));
		$this->assertInstanceOf(DataResponse::class, $controller->destroy('uuid-1'));
	}
}
