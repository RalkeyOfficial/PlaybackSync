<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\CursorService;
use OCA\PlaybackSync\Service\Dto\CursorTarget;
use OCA\PlaybackSync\Service\PlaylistService;
use OCA\PlaybackSync\Service\RoomService;
use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\NicknameGenerator;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\RoomRuntime;
use OCA\PlaybackSync\WebSocket\WsConfig;
use OCP\AppFramework\Db\DoesNotExistException;
use Psr\Log\LoggerInterface;
use Ratchet\ConnectionInterface;
use React\EventLoop\Loop;

/**
 * Handles the `JOIN` message. Responsibilities:
 *
 * 1. Authenticate against the room password.
 * 2. Hydrate the runtime's playlist + cursor + toggle cache from the DB.
 * 3. Merge any `catalogFragment` the extension scraped from the page
 *    (skipped in single mode where the playlist is locked).
 * 4. Empty-playlist seeding from `currentlyShowing` (default-mode →
 *    treat as a server-side seed, freeform-mode → auto-append).
 * 5. Reattach a tombstoned client or create a fresh one, allocate a
 *    nickname, register with the runtime.
 * 6. Reply with `ROOM_STATE` (toggles, cursor, playlistVersion, recent
 *    playback events for reconnect-replay).
 * 7. If the joiner's `currentlyShowing` doesn't match the cursor,
 *    unicast a `CURSOR_CHANGE` to steer them — except in freeform mode
 *    when `currentlyShowing` is omitted (no steer target).
 *
 * The wire reaction matrix is laid out in CONTENT_MODEL_PROTOCOL.md
 * §JOIN steering and in the protocol spec under `Wire contract
 * summary` → "Reaction matrices".
 */
class JoinHandler {

	public function __construct(
		private readonly RoomMapper $roomMapper,
		private readonly RoomService $roomService,
		private readonly PlaylistService $playlistService,
		private readonly CursorService $cursorService,
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
		private readonly WsConfig $config,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * @param array{
	 *   password: string,
	 *   clientId: ?string,
	 *   lastEventId: ?int,
	 *   currentlyShowing: ?array{providerId: string, videoId: string, pageUrl: string},
	 *   catalogFragment: list<array{providerId: string, videoId: string, pageUrl: string, label?: ?string, episodeNumber?: ?int, seasonNumber?: ?int}>
	 * } $payload
	 */
	public function handle(
		ConnectionInterface $conn,
		ConnectionContext $ctx,
		array $payload,
		int $nowMs,
	): void {
		if ($ctx->joined) {
			throw new MessageException('ALREADY_JOINED', 'JOIN already received on this connection');
		}

		$room = $this->loadRoom($ctx->roomUuid, $nowMs);

		if (!$this->roomService->verifyPassword($room, $payload['password'])) {
			throw new MessageException('AUTH_FAILED', 'Incorrect room password', closeAfter: true);
		}

		$runtime = $this->registry->getOrCreate($room->getUuid(), (int)$room->getExpiresAt());
		$runtime->refreshPlaylistFromDb($room);

		$client = $this->reattachOrCreateClient(
			$runtime,
			$conn,
			$payload['clientId'],
			$payload['lastEventId'] ?? 0,
			$nowMs,
		);

		$ctx->clientId = $client->clientId;
		$ctx->joined = true;
		if ($ctx->joinTimer !== null) {
			Loop::get()->cancelTimer($ctx->joinTimer);
			$ctx->joinTimer = null;
		}

		// Merge the joiner's scraped catalog fragment if any. Single mode
		// rejects this implicitly because PlaylistService::merge throws —
		// we swallow the throw and log because the wire contract for JOIN
		// says `catalogFragment` is best-effort, not an auth-rejection.
		if (!$runtime->singleMode && $payload['catalogFragment'] !== []) {
			try {
				$this->playlistService->merge(
					$runtime->uuid,
					$payload['catalogFragment'],
					PlaylistEntry::SOURCE_SCRAPED,
					$client->clientId,
				);
				$room = $this->roomMapper->findByUuid($runtime->uuid);
				$runtime->refreshPlaylistFromDb($room);
			} catch (\Throwable $e) {
				$this->logger->warning('[playbacksync ws] catalogFragment merge skipped: ' . $e->getMessage());
			}
		}

		// Empty-playlist seeding: when the cursor is null and the joiner
		// reports `currentlyShowing`, treat it as the room's first entry.
		// Default → seed as a scraped entry; freeform → auto-append.
		$currentlyShowing = $payload['currentlyShowing'];
		if ($runtime->cursorEntryId === null && $currentlyShowing !== null && !$runtime->singleMode) {
			$this->seedFromCurrentlyShowing($runtime, $currentlyShowing, $client->clientId);
		}

		$runtime->pushEnvelope([
			'ts' => $nowMs,
			'type' => 'client_joined',
			'category' => 'presence',
			'actor' => 'client',
			'actorId' => $client->nickname,
			'data' => ['nickname' => $client->nickname],
		]);

		// Notify the existing peers that someone joined. Only the joiner's own
		// `client_joined` exists at this point, so pre-existing members are not
		// re-announced to the joiner — the joiner instead gets the client-side
		// self "welcome" (emitted from ROOM_STATE in the extension).
		$runtime->broadcastNotice(
			$this->encoder,
			'client_joined',
			'presence',
			'client',
			$client->nickname,
			['nickname' => $client->nickname],
			$nowMs,
			$client->clientId,
		);

		$replay = [];
		if (($payload['lastEventId'] ?? null) !== null) {
			$replay = $runtime->recentEventsSince((int)$payload['lastEventId']);
		}

		$conn->send($this->encoder->roomState(
			$client->clientId,
			$client->nickname,
			$runtime->state,
			$runtime->cursorEntry(),
			$runtime->singleMode,
			$runtime->freeformMode,
			$runtime->playlist,
			$nowMs,
			$replay,
		));

		// Unicast the room's playlist to the joiner: ROOM_STATE only carries
		// `playlistVersion`, so without this the joiner doesn't learn the
		// entries until the next mutation. Clients need them to resolve
		// `CURSOR_CHANGE_REQUEST` targets against the room's known set.
		if ($runtime->playlist !== []) {
			$conn->send($this->encoder->playlistUpdate($runtime->playlist, $nowMs));
		}

		// JOIN steering: unicast a CURSOR_CHANGE when the joiner's tab is
		// on the wrong video (or on a video the room doesn't know yet, in
		// any non-freeform mode). Freeform with `currentlyShowing` omitted
		// also gets no steer.
		if ($currentlyShowing !== null && $runtime->cursorEntry() !== null) {
			$this->maybeSteer($runtime, $conn, $currentlyShowing, $nowMs);
		}
	}

	private function loadRoom(string $uuid, int $nowMs): Room {
		try {
			$room = $this->roomMapper->findByUuid($uuid);
		} catch (DoesNotExistException) {
			throw new MessageException('ROOM_NOT_FOUND', 'Room not found', closeAfter: true);
		}
		if ($room->getExpiresAt() <= $nowMs) {
			throw new MessageException('ROOM_EXPIRED', 'Room has expired', closeAfter: true);
		}
		return $room;
	}

	/**
	 * @param array{providerId: string, videoId: string, pageUrl: string} $currentlyShowing
	 */
	private function seedFromCurrentlyShowing(RoomRuntime $runtime, array $currentlyShowing, string $clientId): void {
		try {
			// Default mode's CursorService path won't create entries — only
			// freeform auto-appends. So in default mode we first merge the
			// joiner's `currentlyShowing` as a scraped entry, then let
			// CursorService resolve to it. Without this, a default-mode
			// joiner with `currentlyShowing` but no usable `catalogFragment`
			// would leave the room with an empty playlist and null cursor.
			if (!$runtime->freeformMode) {
				$this->playlistService->merge(
					$runtime->uuid,
					[$currentlyShowing],
					PlaylistEntry::SOURCE_SCRAPED,
					$clientId,
				);
			}
			$target = CursorTarget::byVideoRef($currentlyShowing + ['label' => null, 'episodeNumber' => null, 'seasonNumber' => null]);
			$this->cursorService->requestChange($runtime->uuid, $target, $clientId);
			$room = $this->roomMapper->findByUuid($runtime->uuid);
			$runtime->refreshPlaylistFromDb($room);
		} catch (\Throwable $e) {
			$this->logger->warning('[playbacksync ws] empty-playlist seed skipped: ' . $e->getMessage());
		}
	}

	/**
	 * Unicast a `CURSOR_CHANGE` to the joiner when their `currentlyShowing`
	 * does not match the current cursor. This is wire-level steering and
	 * applies under all modes — single locks the playlist, not the
	 * cursor steering. Freeform's "polite follow" matches default-mode
	 * behaviour for now; the "eager append" alternative is deferred to
	 * the freeform spec.
	 *
	 * @param array{providerId: string, videoId: string, pageUrl: string} $currentlyShowing
	 */
	private function maybeSteer(RoomRuntime $runtime, ConnectionInterface $conn, array $currentlyShowing, int $nowMs): void {
		$cursor = $runtime->cursorEntry();
		if ($cursor === null) {
			return;
		}
		$showingKey = strtolower($currentlyShowing['providerId']) . '|' . strtolower($currentlyShowing['videoId']);
		$cursorKey = strtolower($cursor->providerId) . '|' . strtolower($cursor->videoId);
		if ($showingKey === $cursorKey) {
			return;
		}
		$conn->send($this->encoder->cursorChange($cursor, $runtime->state->eventId, $nowMs));
	}

	private function reattachOrCreateClient(
		RoomRuntime $runtime,
		ConnectionInterface $conn,
		?string $requestedClientId,
		int $clientLastEventId,
		int $nowMs,
	): ClientConnection {
		if ($requestedClientId !== null) {
			if ($runtime->isClientBlocked($requestedClientId, $nowMs)) {
				throw new MessageException('KICKED', 'Disconnected by room owner', closeAfter: true);
			}
			$existing = $runtime->getClient($requestedClientId);
			if ($existing !== null && $existing->isTombstoned($nowMs)) {
				$existing->reattach($conn, $nowMs);
				$existing->lastEventId = max($existing->lastEventId, $clientLastEventId);
				return $existing;
			}
			if ($existing !== null) {
				throw new MessageException('CLIENT_ID_IN_USE', 'clientId already connected', closeAfter: true);
			}
		}

		$clientId = $requestedClientId ?? bin2hex(random_bytes(16));
		$client = new ClientConnection(
			$clientId,
			NicknameGenerator::generate(),
			$conn,
			$nowMs,
			$runtime->state->eventId,
			new RateLimiter($this->config->rateLimitEventsPerSec, $nowMs),
			new RateLimiter($this->config->rateLimitPlaylistPerSec, $nowMs),
		);
		$runtime->addClient($client);
		return $client;
	}
}
