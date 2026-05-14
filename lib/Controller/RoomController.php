<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Http\SseStreamResponse;
use OCA\PlaybackSync\Service\AdminEventClient;
use OCA\PlaybackSync\Service\CursorService;
use OCA\PlaybackSync\Service\Dto\CursorTarget;
use OCA\PlaybackSync\Service\Dto\RoomLiveState;
use OCA\PlaybackSync\Service\Exceptions\ClientNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\CreateRestrictedException;
use OCA\PlaybackSync\Service\Exceptions\CursorEntryNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\CursorLockedEntryException;
use OCA\PlaybackSync\Service\Exceptions\InvalidEntryPatchException;
use OCA\PlaybackSync\Service\Exceptions\InvalidRoomInputException;
use OCA\PlaybackSync\Service\Exceptions\KickFailedException;
use OCA\PlaybackSync\Service\Exceptions\NotInPlaylistException;
use OCA\PlaybackSync\Service\Exceptions\PlaybackCommandFailedException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistCapExceededException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistLockedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotLiveException;
use OCA\PlaybackSync\Service\Exceptions\ToggleConflictException;
use OCA\PlaybackSync\Service\PlaylistService;
use OCA\PlaybackSync\Service\RoomBroadcaster;
use OCA\PlaybackSync\Service\RoomLiveStateEnricher;
use OCA\PlaybackSync\Service\RoomService;
use OCP\AppFramework\Db\DoesNotExistException;
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
		private PlaylistService $playlistService,
		private CursorService $cursorService,
		private RoomBroadcaster $broadcaster,
		private RoomMapper $roomMapper,
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

	/**
	 * @param string                                                                                                                                          $bootstrapUrl   Share-link redirect target (http(s) URL).
	 * @param string|null                                                                                                                                     $name           Optional human-readable label.
	 * @param int|null                                                                                                                                        $ttl            Time-to-live in seconds; clamped to the app-configured max.
	 * @param bool                                                                                                                                            $singleMode     When true, the playlist is locked (no PLAYLIST_UPDATE). Mutually exclusive with `$freeformMode`.
	 * @param bool                                                                                                                                            $freeformMode   When true, the cursor handling relaxes (joiner steering off, auto-append on cursor jump). Mutually exclusive with `$singleMode`.
	 * @param list<array{providerId: string, videoId: string, pageUrl: string, label?: string|null, episodeNumber?: int|null, seasonNumber?: int|null}>|null $initialEntries Curated entries to seed the playlist with at creation time. Defaults to an empty playlist.
	 */
	#[NoAdminRequired]
	public function create(
		string $bootstrapUrl,
		?string $name = null,
		?int $ttl = null,
		bool $singleMode = false,
		bool $freeformMode = false,
		?array $initialEntries = null,
	): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$result = $this->service->createRoom(
				$this->userId,
				$bootstrapUrl,
				$name,
				$ttl,
				$singleMode,
				$freeformMode,
				$initialEntries ?? [],
			);
		} catch (CreateRestrictedException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_FORBIDDEN);
		} catch (ToggleConflictException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'toggle_conflict'], Http::STATUS_BAD_REQUEST);
		} catch (PlaylistCapExceededException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => $e->capCode], Http::STATUS_BAD_REQUEST);
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
	 * Flip one or both mode toggles. Either argument may be `null` to
	 * leave that toggle alone. Rejects the `(true, true)` combination
	 * with `toggle_conflict`.
	 */
	#[NoAdminRequired]
	public function settings(string $uuid, ?bool $singleMode = null, ?bool $freeformMode = null): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$room = $this->service->setToggles($this->userId, $uuid, $singleMode, $freeformMode);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		} catch (ToggleConflictException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'toggle_conflict'], Http::STATUS_BAD_REQUEST);
		}

		$this->broadcaster->broadcastRoomState($uuid, $this->userId);
		return new DataResponse($this->serializeRoom($room));
	}

	/**
	 * Add one curated entry to the room's playlist. Called from the
	 * dashboard "add video" flow. Wraps `PlaylistService::merge` with
	 * a single-entry candidate list so the merge rules apply uniformly.
	 *
	 * @param string $uuid Room UUID.
	 * @param string $providerId Provider slug (`youtube`, `crunchyroll`, …).
	 * @param string $videoId Provider's video identifier; forms half of the natural key.
	 * @param string $pageUrl Canonical URL the extension should navigate to.
	 * @param string|null $label Optional human label; auto-filled (e.g. via oEmbed) when omitted.
	 * @param int|null $episodeNumber Optional series episode number.
	 * @param int|null $seasonNumber Optional series season number.
	 */
	#[NoAdminRequired]
	public function addPlaylistEntry(
		string $uuid,
		string $providerId,
		string $videoId,
		string $pageUrl,
		?string $label = null,
		?int $episodeNumber = null,
		?int $seasonNumber = null,
	): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		// Reuse the owner-check helper for opaque 404s on non-owned rooms.
		try {
			$this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		try {
			$this->playlistService->merge(
				$uuid,
				[[
					'providerId' => $providerId,
					'videoId' => $videoId,
					'pageUrl' => $pageUrl,
					'label' => $label,
					'episodeNumber' => $episodeNumber,
					'seasonNumber' => $seasonNumber,
					'source' => 'curated',
				]],
				'curated',
				$this->userId,
			);
		} catch (PlaylistLockedException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'single_mode_locked'], Http::STATUS_CONFLICT);
		} catch (PlaylistCapExceededException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => $e->capCode], Http::STATUS_BAD_REQUEST);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		$this->broadcaster->broadcastPlaylistUpdate($uuid, $this->userId);
		return new DataResponse($this->serializePlaylist($uuid));
	}

	/**
	 * Patch a single playlist entry. Used by the dashboard playlist editor
	 * for label edits, position moves (reorder), and "convert to curated"
	 * promotions. All fields are optional; the service applies only the
	 * supplied ones.
	 *
	 * @param string      $uuid          Room UUID.
	 * @param string      $entryId       Server-assigned entry id (`e_…`).
	 * @param string|null $label         New label, or `null` to leave the label unchanged.
	 * @param int|null    $episodeNumber New episode number, or `null` to leave unchanged.
	 * @param int|null    $seasonNumber  New season number, or `null` to leave unchanged.
	 * @param int|null    $position      Target 1-based position. Renumbers neighbours. Rejected in single mode.
	 * @param string|null $source        Only `"curated"` is a valid value (promotion). Other values rejected.
	 */
	#[NoAdminRequired]
	public function updatePlaylistEntry(
		string $uuid,
		string $entryId,
		?string $label = null,
		?int $episodeNumber = null,
		?int $seasonNumber = null,
		?int $position = null,
		?string $source = null,
	): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		try {
			$this->playlistService->updateEntry(
				$uuid,
				$entryId,
				$label,
				$episodeNumber,
				$seasonNumber,
				$position,
				$source,
			);
		} catch (PlaylistLockedException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'single_mode_locked'], Http::STATUS_CONFLICT);
		} catch (InvalidEntryPatchException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'invalid_entry_patch'], Http::STATUS_BAD_REQUEST);
		} catch (CursorEntryNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		$this->broadcaster->broadcastPlaylistUpdate($uuid, $this->userId);
		return new DataResponse($this->serializePlaylist($uuid));
	}

	/**
	 * Bulk "clear all" — wipes the playlist and resets the cursor in one
	 * atomic write. Distinct code path from single-entry delete: the
	 * cursor-lock guard does not apply (per CONTENT_MODEL_DEFAULT.md). Defends
	 * against accidental DELETE requests by requiring an
	 * `X-Playbacksync-Confirm-Clear: true` header.
	 */
	#[NoAdminRequired]
	public function clearPlaylist(string $uuid): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		if ($this->request->getHeader('X-Playbacksync-Confirm-Clear') !== 'true') {
			return new DataResponse(
				['error' => 'missing X-Playbacksync-Confirm-Clear: true header', 'code' => 'missing_confirm_header'],
				Http::STATUS_BAD_REQUEST,
			);
		}

		try {
			$this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		try {
			$this->playlistService->clearAll($uuid);
		} catch (PlaylistLockedException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'single_mode_locked'], Http::STATUS_CONFLICT);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		$this->broadcaster->broadcastPlaylistUpdate($uuid, $this->userId);
		return new DataResponse(null, Http::STATUS_NO_CONTENT);
	}

	#[NoAdminRequired]
	public function removePlaylistEntry(string $uuid, string $entryId): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		try {
			$this->playlistService->removeEntry($uuid, $entryId);
		} catch (PlaylistLockedException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'single_mode_locked'], Http::STATUS_CONFLICT);
		} catch (CursorLockedEntryException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'cursor_locked_entry'], Http::STATUS_CONFLICT);
		} catch (CursorEntryNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		$this->broadcaster->broadcastPlaylistUpdate($uuid, $this->userId);
		return new DataResponse(null, Http::STATUS_NO_CONTENT);
	}

	/**
	 * Owner-driven cursor move from the dashboard picker. Uses the same
	 * `CursorService::requestChange` path as the WS handler so per-mode
	 * rules apply (single-mode locks new videos; default mode requires
	 * the entry to exist; freeform auto-appends raw video refs).
	 */
	#[NoAdminRequired]
	public function setCursor(string $uuid, string $targetEntryId): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		try {
			$this->cursorService->requestChange($uuid, CursorTarget::byEntryId($targetEntryId), $this->userId);
		} catch (PlaylistLockedException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'single_mode_locked'], Http::STATUS_CONFLICT);
		} catch (NotInPlaylistException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'not_in_playlist'], Http::STATUS_BAD_REQUEST);
		} catch (CursorEntryNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage(), 'code' => 'not_in_playlist'], Http::STATUS_BAD_REQUEST);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		$this->broadcaster->broadcastCursorChange($uuid, $this->userId);
		return new DataResponse(null, Http::STATUS_NO_CONTENT);
	}

	#[NoAdminRequired]
	public function playlist(string $uuid): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$this->service->getOwnedRoom($this->userId, $uuid);
		} catch (RoomNotFoundException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		}

		return new DataResponse($this->serializePlaylist($uuid));
	}

	/**
	 * Re-read the room and project the current playlist + version onto
	 * the wire shape used by `GET /playlist` and the response of
	 * `POST /playlist/entries`. Centralised so the version string is
	 * computed the same way the WS encoder computes it.
	 *
	 * @return array{entries: list<array<string, mixed>>, cursorEntryId: ?string, playlistVersion: string}
	 */
	private function serializePlaylist(string $uuid): array {
		try {
			$room = $this->roomMapper->findByUuid($uuid);
		} catch (DoesNotExistException) {
			return ['entries' => [], 'cursorEntryId' => null, 'playlistVersion' => 'v0'];
		}
		$entries = $room->getPlaylistEntries();
		return [
			'entries' => array_map(static fn ($e) => $e->toArray(), $entries),
			'cursorEntryId' => $room->getCursorEntryId(),
			'playlistVersion' => \OCA\PlaybackSync\WebSocket\MessageEncoder::playlistVersion($entries),
		];
	}

	/**
	 * `live` is always present in the wire payload (never omitted) so the
	 * frontend can branch on `room.live === null` rather than worrying about
	 * undefined keys. `null` means the daemon couldn't be reached or has no
	 * state for this room; an object means current presence + playback.
	 *
	 * The playlist and cursor live in the persisted `Room` shape rather
	 * than in `live` — they survive a daemon restart and are owner-visible
	 * even when nobody is connected.
	 *
	 * @return array{
	 *     uuid: string,
	 *     name: ?string,
	 *     bootstrapUrl: string,
	 *     singleMode: bool,
	 *     freeformMode: bool,
	 *     playlist: list<array{
	 *         entryId: string,
	 *         position: int,
	 *         providerId: string,
	 *         videoId: string,
	 *         pageUrl: string,
	 *         label: ?string,
	 *         episodeNumber: ?int,
	 *         seasonNumber: ?int,
	 *         source: string,
	 *         addedBy: string,
	 *         addedAt: int,
	 *         lastSeenAt: int
	 *     }>,
	 *     cursorEntryId: ?string,
	 *     createdAt: int,
	 *     expiresAt: int,
	 *     shareLink: string,
	 *     live: ?array{
	 *         connectedCount: int,
	 *         clients: list<array{clientId: string, nickname: string, isBuffering: bool, lastSeenMs: int}>,
	 *         playerState: string,
	 *         videoPos: float,
	 *         lastActivityMs: ?int
	 *     }
	 * }
	 */
	private function serializeRoom(Room $room, ?RoomLiveState $live = null): array {
		return [
			'uuid' => $room->getUuid(),
			'name' => $room->getName(),
			'bootstrapUrl' => $room->getBootstrapUrl(),
			'singleMode' => $room->getSingleMode(),
			'freeformMode' => $room->getFreeformMode(),
			'playlist' => array_map(
				static fn ($entry) => $entry->toArray(),
				$room->getPlaylistEntries(),
			),
			'cursorEntryId' => $room->getCursorEntryId(),
			'createdAt' => $room->getCreatedAt(),
			'expiresAt' => $room->getExpiresAt(),
			'shareLink' => $this->urlGenerator->getAbsoluteURL('/index.php/apps/playbacksync/r/' . $room->getUuid()),
			'live' => $live?->toArray(),
		];
	}
}
