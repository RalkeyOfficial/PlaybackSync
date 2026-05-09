<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Service\Exceptions\CreateRestrictedException;
use OCA\PlaybackSync\Service\Exceptions\InvalidRoomInputException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\RoomService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IURLGenerator;

class RoomController extends Controller {

	public function __construct(
		string $appName,
		IRequest $request,
		private ?string $userId,
		private RoomService $service,
		private IURLGenerator $urlGenerator,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		$rooms = $this->service->listForOwner($this->userId);
		return new DataResponse([
			'rooms' => array_map(fn (Room $r) => $this->serializeRoom($r), $rooms),
		]);
	}

	#[NoAdminRequired]
	public function show(string $uuid): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$room = $this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		return new DataResponse($this->serializeRoom($room));
	}

	#[NoAdminRequired]
	public function create(string $targetUrl, ?string $name = null, ?int $ttl = null): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$result = $this->service->createRoom($this->userId, $targetUrl, $name, $ttl);
		} catch (CreateRestrictedException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_FORBIDDEN);
		} catch (InvalidRoomInputException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}

		$payload = $this->serializeRoom($result['room']);
		$payload['password'] = $result['plainPassword'];

		return new DataResponse($payload, Http::STATUS_CREATED);
	}

	#[NoAdminRequired]
	public function destroy(string $uuid): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$this->service->deleteOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		return new DataResponse(null, Http::STATUS_NO_CONTENT);
	}

	/**
	 * @return array{uuid:string,name:?string,targetUrl:string,createdAt:int,expiresAt:int,shareLink:string}
	 */
	private function serializeRoom(Room $room): array {
		return [
			'uuid' => $room->getUuid(),
			'name' => $room->getName(),
			'targetUrl' => $room->getTargetUrl(),
			'createdAt' => $room->getCreatedAt(),
			'expiresAt' => $room->getExpiresAt(),
			'shareLink' => $this->urlGenerator->getAbsoluteURL('/index.php/apps/playbacksync/r/' . $room->getUuid()),
		];
	}
}
