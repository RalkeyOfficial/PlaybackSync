<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Service\Dto\RoomLiveState;
use OCA\PlaybackSync\Service\Exceptions\ClientNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\CreateRestrictedException;
use OCA\PlaybackSync\Service\Exceptions\InvalidRoomInputException;
use OCA\PlaybackSync\Service\Exceptions\KickFailedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\RoomLiveStateEnricher;
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
		private RoomLiveStateEnricher $liveStateEnricher,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		$rooms = $this->service->listForOwner($this->userId);
		$live = $this->liveStateEnricher->enrich($rooms);
		return new DataResponse([
			'rooms' => array_map(
				fn (Room $r) => $this->serializeRoom($r, $live[$r->getUuid()] ?? null),
				$rooms,
			),
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

		$live = $this->liveStateEnricher->enrich([$room]);
		return new DataResponse($this->serializeRoom($room, $live[$room->getUuid()] ?? null));
	}

	/**
	 * Focused presence-only endpoint: a slimmer payload than `show()` for
	 * callers (future detail pages, polling clients) that only care about
	 * who is currently in the room.
	 */
	#[NoAdminRequired]
	public function clients(string $uuid): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$room = $this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		$live = ($this->liveStateEnricher->enrich([$room]))[$room->getUuid()] ?? null;
		return new DataResponse([
			'connectedCount' => $live?->connectedCount ?? 0,
			'clients' => $live?->clients ?? [],
		]);
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

	#[NoAdminRequired]
	public function kickClient(string $uuid, string $clientId): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$this->service->kickClient($this->userId, $uuid, $clientId);
		} catch (RoomNotFoundException|ClientNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		} catch (KickFailedException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_BAD_GATEWAY);
		}

		return new DataResponse(null, Http::STATUS_NO_CONTENT);
	}

	/**
	 * `live` is always present in the wire payload (never omitted) so the
	 * frontend can branch on `room.live === null` rather than worrying about
	 * undefined keys. `null` means the daemon couldn't be reached or has no
	 * state for this room; an object means current presence + playback.
	 *
	 * @return array{
	 *     uuid: string,
	 *     name: ?string,
	 *     targetUrl: string,
	 *     createdAt: int,
	 *     expiresAt: int,
	 *     shareLink: string,
	 *     live: ?array{
	 *         connectedCount: int,
	 *         clients: list<array{clientId: string, isBuffering: bool, lastSeenMs: int}>,
	 *         playerState: string,
	 *         videoPos: float,
	 *         contentIdentity: ?array{providerId: string, episodeId: string, pageUrl: string, contentKey: string},
	 *         lastActivityMs: ?int
	 *     }
	 * }
	 */
	private function serializeRoom(Room $room, ?RoomLiveState $live = null): array {
		return [
			'uuid' => $room->getUuid(),
			'name' => $room->getName(),
			'targetUrl' => $room->getTargetUrl(),
			'createdAt' => $room->getCreatedAt(),
			'expiresAt' => $room->getExpiresAt(),
			'shareLink' => $this->urlGenerator->getAbsoluteURL('/index.php/apps/playbacksync/r/' . $room->getUuid()),
			'live' => $live?->toArray(),
		];
	}
}
