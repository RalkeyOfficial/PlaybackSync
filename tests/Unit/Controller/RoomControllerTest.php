<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Controller;

use OCA\PlaybackSync\Controller\RoomController;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Service\Dto\RoomLiveState;
use OCA\PlaybackSync\Service\Exceptions\ClientNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\CreateRestrictedException;
use OCA\PlaybackSync\Service\Exceptions\InvalidRoomInputException;
use OCA\PlaybackSync\Service\Exceptions\KickFailedException;
use OCA\PlaybackSync\Service\Exceptions\PlaybackCommandFailedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotLiveException;
use OCA\PlaybackSync\Service\RoomLiveStateEnricher;
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
	private RoomLiveStateEnricher&MockObject $liveStateEnricher;

	protected function setUp(): void {
		parent::setUp();
		$this->request = $this->createMock(IRequest::class);
		$this->service = $this->createMock(RoomService::class);
		$this->urlGenerator = $this->createMock(IURLGenerator::class);
		$this->urlGenerator->method('getAbsoluteURL')
			->willReturnCallback(static fn (string $path): string => 'https://nc.test' . $path);

		// Default: enricher returns null for every uuid (i.e. daemon down /
		// not configured). Specific tests override via the `mockLiveState`
		// helper when they want to exercise the populated path.
		$this->liveStateEnricher = $this->createMock(RoomLiveStateEnricher::class);
		$this->liveStateEnricher->method('enrich')->willReturnCallback(
			static function (array $rooms): array {
				$out = [];
				foreach ($rooms as $r) {
					$out[$r->getUuid()] = null;
				}
				return $out;
			},
		);
	}

	private function controller(?string $userId): RoomController {
		return new RoomController(
			'playbacksync',
			$this->request,
			$userId,
			$this->service,
			$this->urlGenerator,
			$this->liveStateEnricher,
		);
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

	// ─── kickClient ──────────────────────────────────────────────────────

	public function testKickClientReturns401WhenNotLoggedIn(): void {
		$response = $this->controller(null)->kickClient('uuid-1', 'deadbeef');

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
	}

	public function testKickClientReturns204OnSuccess(): void {
		$this->service->expects($this->once())
			->method('kickClient')
			->with('alice', 'uuid-1', 'deadbeef');

		$response = $this->controller('alice')->kickClient('uuid-1', 'deadbeef');

		$this->assertSame(Http::STATUS_NO_CONTENT, $response->getStatus());
		$this->assertNull($response->getData());
	}

	public function testKickClientReturns404WhenServiceThrowsRoomNotFound(): void {
		$this->service->method('kickClient')
			->willThrowException(new RoomNotFoundException('Room not found.'));

		$response = $this->controller('alice')->kickClient('missing', 'deadbeef');

		$this->assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
		$this->assertSame(['error' => 'Room not found.'], $response->getData());
	}

	public function testKickClientReturns404WhenServiceThrowsClientNotFound(): void {
		$this->service->method('kickClient')
			->willThrowException(new ClientNotFoundException('Client is not connected to this room.'));

		$response = $this->controller('alice')->kickClient('uuid-1', 'ghost');

		$this->assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
		$this->assertSame(['error' => 'Client is not connected to this room.'], $response->getData());
	}

	public function testKickClientReturns502WhenDaemonUnreachable(): void {
		$this->service->method('kickClient')
			->willThrowException(new KickFailedException('WebSocket daemon unreachable.'));

		$response = $this->controller('alice')->kickClient('uuid-1', 'deadbeef');

		$this->assertSame(Http::STATUS_BAD_GATEWAY, $response->getStatus());
		$this->assertSame(['error' => 'WebSocket daemon unreachable.'], $response->getData());
	}

	// ─── playback ────────────────────────────────────────────────────────

	public function testPlaybackReturns401WhenNotLoggedIn(): void {
		$response = $this->controller(null)->playback('uuid-1', 'play');

		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
	}

	public function testPlaybackReturns400ForUnknownAction(): void {
		$this->service->expects($this->never())->method('sendPlaybackCommand');

		$response = $this->controller('alice')->playback('uuid-1', 'fastforward');

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
		$this->assertSame(['error' => 'invalid_action'], $response->getData());
	}

	public function testPlaybackReturns400WhenSeekMissingPosition(): void {
		$this->service->expects($this->never())->method('sendPlaybackCommand');

		$response = $this->controller('alice')->playback('uuid-1', 'seek');

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
		$this->assertSame(['error' => 'invalid_position'], $response->getData());
	}

	public function testPlaybackReturns400WhenSeekPositionNegative(): void {
		$this->service->expects($this->never())->method('sendPlaybackCommand');

		$response = $this->controller('alice')->playback('uuid-1', 'seek', -1.0);

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
		$this->assertSame(['error' => 'invalid_position'], $response->getData());
	}

	public function testPlaybackReturns204OnSuccess(): void {
		$this->service->expects($this->once())
			->method('sendPlaybackCommand')
			->with('alice', 'uuid-1', 'seek', 120.0);

		$response = $this->controller('alice')->playback('uuid-1', 'seek', 120.0);

		$this->assertSame(Http::STATUS_NO_CONTENT, $response->getStatus());
		$this->assertNull($response->getData());
	}

	public function testPlaybackReturns204ForPlayWithoutPosition(): void {
		$this->service->expects($this->once())
			->method('sendPlaybackCommand')
			->with('alice', 'uuid-1', 'play', null);

		$response = $this->controller('alice')->playback('uuid-1', 'play');

		$this->assertSame(Http::STATUS_NO_CONTENT, $response->getStatus());
	}

	public function testPlaybackReturns404WhenRoomNotFound(): void {
		$this->service->method('sendPlaybackCommand')
			->willThrowException(new RoomNotFoundException('Room not found.'));

		$response = $this->controller('alice')->playback('missing', 'play');

		$this->assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
		$this->assertSame(['error' => 'Room not found.'], $response->getData());
	}

	public function testPlaybackReturns409WhenRoomNotLive(): void {
		$this->service->method('sendPlaybackCommand')
			->willThrowException(new RoomNotLiveException('no clients'));

		$response = $this->controller('alice')->playback('uuid-1', 'play');

		$this->assertSame(Http::STATUS_CONFLICT, $response->getStatus());
		$this->assertSame(['error' => 'room_not_live'], $response->getData());
	}

	public function testPlaybackReturns502WhenDaemonUnreachable(): void {
		$this->service->method('sendPlaybackCommand')
			->willThrowException(new PlaybackCommandFailedException('WebSocket daemon unreachable.'));

		$response = $this->controller('alice')->playback('uuid-1', 'pause');

		$this->assertSame(Http::STATUS_BAD_GATEWAY, $response->getStatus());
		$this->assertSame(['error' => 'WebSocket daemon unreachable.'], $response->getData());
	}

	// ─── live-state ──────────────────────────────────────────────────────

	/**
	 * The `live` key is always present in the wire payload. When the daemon
	 * has nothing for the room, the value is `null` — the frontend branches
	 * on that, never on key existence.
	 */
	public function testIndexAlwaysIncludesLiveKeyEvenWhenNull(): void {
		$this->service->method('listForOwner')->willReturn([$this->makeRoom()]);

		$response = $this->controller('alice')->index();

		$payload = $response->getData();
		$this->assertArrayHasKey('live', $payload['rooms'][0]);
		$this->assertNull($payload['rooms'][0]['live']);
	}

	/**
	 * When the enricher does have data for the room, the controller merges
	 * the DTO's array shape under `live`. This is the only place the
	 * connectedCount surfaces to clients of the rooms API.
	 */
	public function testIndexMergesLiveStateWhenAvailable(): void {
		$room = $this->makeRoom();
		$this->service->method('listForOwner')->willReturn([$room]);

		$dto = new RoomLiveState(
			connectedCount: 3,
			clients: [
				['clientId' => 'alice-1', 'isBuffering' => false, 'lastSeenMs' => 1_700_000_000_000],
			],
			playerState: 'playing',
			videoPos: 12.5,
			contentIdentity: null,
			lastActivityMs: 1_700_000_000_000,
		);
		// Override the default-null mock from setUp.
		$this->liveStateEnricher = $this->createMock(RoomLiveStateEnricher::class);
		$this->liveStateEnricher->method('enrich')->willReturn([$room->getUuid() => $dto]);

		$payload = $this->controller('alice')->index()->getData();
		$live = $payload['rooms'][0]['live'];
		$this->assertNotNull($live);
		$this->assertSame(3, $live['connectedCount']);
		$this->assertSame('playing', $live['playerState']);
	}

	// ─── clients ─────────────────────────────────────────────────────────

	public function testClientsReturns401WhenNotLoggedIn(): void {
		$response = $this->controller(null)->clients('uuid-1');
		$this->assertSame(Http::STATUS_UNAUTHORIZED, $response->getStatus());
	}

	public function testClientsReturns404WhenServiceThrowsNotFound(): void {
		$this->service->method('getOwnedRoom')->willThrowException(new RoomNotFoundException('Room not found.'));

		$response = $this->controller('alice')->clients('missing');

		$this->assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
	}

	public function testClientsReturnsZeroAndEmptyListWhenLiveStateUnavailable(): void {
		$this->service->method('getOwnedRoom')->willReturn($this->makeRoom());

		$response = $this->controller('alice')->clients('uuid-1');

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertSame(['connectedCount' => 0, 'clients' => []], $response->getData());
	}

	public function testClientsReturnsConnectedClientsWhenAvailable(): void {
		$room = $this->makeRoom();
		$this->service->method('getOwnedRoom')->willReturn($room);

		$dto = new RoomLiveState(
			connectedCount: 2,
			clients: [
				['clientId' => 'alice-1', 'isBuffering' => false, 'lastSeenMs' => 1_700_000_001_000],
				['clientId' => 'bob-1', 'isBuffering' => true, 'lastSeenMs' => 1_700_000_002_000],
			],
			playerState: 'playing',
			videoPos: 0.0,
			contentIdentity: null,
			lastActivityMs: 1_700_000_002_000,
		);
		$this->liveStateEnricher = $this->createMock(RoomLiveStateEnricher::class);
		$this->liveStateEnricher->method('enrich')->willReturn([$room->getUuid() => $dto]);

		$response = $this->controller('alice')->clients('uuid-1');

		$payload = $response->getData();
		$this->assertSame(2, $payload['connectedCount']);
		$this->assertCount(2, $payload['clients']);
		$this->assertSame('alice-1', $payload['clients'][0]['clientId']);
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
