<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
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
use Ratchet\ConnectionInterface;
use React\EventLoop\Loop;

/**
 * Handles the `JOIN` message: authenticates the connection against the
 * room password, reattaches tombstoned clients, hydrates the room
 * runtime's playlist + cursor cache from the database (so a daemon
 * restart doesn't lose what the room was watching), and sends back the
 * initial `ROOM_STATE` (with a tail of recent events when this is a
 * reconnect).
 *
 * Content-identity reconciliation and joiner steering live in the
 * protocol spec — under the new playlist+cursor model the wire payload
 * carries `(providerId, episodeId, pageUrl)` only for backwards
 * compatibility, and the handler currently ignores it.
 */
class JoinHandler {

	public function __construct(
		private readonly RoomMapper $roomMapper,
		private readonly RoomService $roomService,
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
		private readonly WsConfig $config,
	) {
	}

	/**
	 * @param array{password: string, clientId: ?string, lastEventId: ?int, episodeId: ?string, providerId: ?string, pageUrl: ?string} $payload
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
		// Hydrate (or refresh) the runtime's playlist + cursor cache from
		// persisted state. Cheap when the runtime already existed — the
		// JSON column round-trip plus a sort. Idempotent.
		$this->hydrateRuntime($runtime, $room);

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

		$runtime->pushEnvelope([
			'ts' => $nowMs,
			'type' => 'client_joined',
			'category' => 'presence',
			'actor' => 'client',
			'actorId' => $client->nickname,
			'data' => ['nickname' => $client->nickname],
		]);

		$replay = [];
		if ($payload['lastEventId'] !== null) {
			$replay = $runtime->recentEventsSince($payload['lastEventId']);
		}

		$conn->send($this->encoder->roomState(
			$client->clientId,
			$runtime->state,
			$runtime->cursorEntry(),
			$nowMs,
			$replay,
		));
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
	 * Mirror the persisted playlist + cursor onto the runtime cache. If
	 * the runtime already has entries it's overwritten — the DB is the
	 * source of truth.
	 */
	private function hydrateRuntime(RoomRuntime $runtime, Room $room): void {
		$runtime->refreshPlaylistFromDb($room);
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
				// Same id is already actively connected — refuse the duplicate.
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
		);
		$runtime->addClient($client);
		return $client;
	}
}
