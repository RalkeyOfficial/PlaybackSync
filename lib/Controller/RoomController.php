<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Http\SseStreamResponse;
use OCA\PlaybackSync\Service\AdminEventClient;
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
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\Response;
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
		private AdminEventClient $eventClient,
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
	 * Owner-driven playback command. Mutates the daemon's authoritative
	 * playback state and triggers a `STATE` broadcast to every connected
	 * client.
	 *
	 * @param string     $uuid     Room UUID.
	 * @param string     $action   One of `play`, `pause`, `seek`, `reset`.
	 * @param float|null $videoPos Target position in seconds. Required and ≥0
	 *                             when `$action === 'seek'`; ignored otherwise.
	 */
	#[NoAdminRequired]
	public function playback(string $uuid, string $action, ?float $videoPos = null): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		$allowed = ['play', 'pause', 'seek', 'reset'];
		if (!in_array($action, $allowed, true)) {
			return new DataResponse(
				['error' => 'invalid_action'],
				Http::STATUS_BAD_REQUEST,
			);
		}

		if ($action === 'seek' && ($videoPos === null || $videoPos < 0.0)) {
			return new DataResponse(
				['error' => 'invalid_position'],
				Http::STATUS_BAD_REQUEST,
			);
		}

		try {
			$this->service->sendPlaybackCommand($this->userId, $uuid, $action, $videoPos);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		} catch (RoomNotLiveException $e) {
			return new DataResponse(['error' => 'room_not_live'], Http::STATUS_CONFLICT);
		} catch (PlaybackCommandFailedException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_BAD_GATEWAY);
		}

		return new DataResponse(null, Http::STATUS_NO_CONTENT);
	}

	/**
	 * Owner-gated SSE stream of the room's event log. The response stays open
	 * for the lifetime of the FPM worker — `SseStreamResponse` flips the worker
	 * into streaming mode and the producer below proxies bytes from the daemon
	 * straight to the browser.
	 *
	 * Returns 404 (opaque, same shape as `show()`) when the room doesn't exist
	 * or the requester isn't the owner. Returns 401 when unauthenticated.
	 *
	 * `Last-Event-ID` is read from the standard SSE header or the
	 * `?lastEventId=` query fallback; the daemon also accepts either.
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function eventsStream(string $uuid): Response {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		$lastEventId = $this->parseClientLastEventId();
		$client = $this->eventClient;

		return new SseStreamResponse(static function () use ($client, $uuid, $lastEventId): void {
			$aborted = false;
			$client->streamRoom($uuid, $lastEventId, static function (string $chunk) use (&$aborted): int {
				if ($aborted) {
					return 0;
				}
				echo $chunk;
				@ob_flush();
				@flush();
				if (connection_aborted()) {
					$aborted = true;
					return 0;
				}
				return strlen($chunk);
			});
		});
	}

	/**
	 * Read the SSE replay cursor from the incoming request. EventSource sends
	 * `Last-Event-ID` on automatic reconnect; we also accept `?lastEventId=`
	 * for hand-rolled callers and tests.
	 */
	private function parseClientLastEventId(): ?int {
		$headerValue = $this->request->getHeader('Last-Event-ID');
		if ($headerValue !== '' && ctype_digit($headerValue)) {
			return (int)$headerValue;
		}
		$query = $this->request->getParam('lastEventId');
		if (is_string($query) && ctype_digit($query)) {
			return (int)$query;
		}
		if (is_int($query)) {
			return $query;
		}
		return null;
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
