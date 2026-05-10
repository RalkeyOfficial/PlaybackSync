<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Handler;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\RoomService;
use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\ContentIdentity;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\WsConfig;
use OCP\AppFramework\Db\DoesNotExistException;
use Ratchet\ConnectionInterface;
use React\EventLoop\Loop;

/**
 * Handles the `JOIN` message: authenticates the connection against the
 * room password, reattaches tombstoned clients, reconciles content
 * identity, and sends back the initial `ROOM_STATE` (with a tail of
 * recent events when this is a reconnect).
 *
 * Error contract: any failure throws `MessageException`. The router maps
 * fatal codes (auth/room missing/content mismatch) to a close-after-error
 * frame; the handler does not close the connection itself.
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

		$this->reconcileContentIdentity($runtime, $payload, $nowMs);

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

		$replay = [];
		if ($payload['lastEventId'] !== null) {
			$replay = $runtime->recentEventsSince($payload['lastEventId']);
		}

		$conn->send($this->encoder->roomState(
			$client->clientId,
			$runtime->state,
			$runtime->contentIdentity,
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
	 * @param array{episodeId: ?string, providerId: ?string, pageUrl: ?string} $payload
	 */
	private function reconcileContentIdentity(\OCA\PlaybackSync\WebSocket\RoomRuntime $runtime, array $payload, int $nowMs): void {
		// All-three or none was already enforced by the validator.
		if ($payload['episodeId'] === null) {
			return;
		}
		$reportedKey = ContentIdentity::deriveKey(
			$payload['providerId'],
			$payload['episodeId'],
			$payload['pageUrl'],
		);
		if ($runtime->contentIdentity === null) {
			$runtime->contentIdentity = new ContentIdentity(
				$payload['providerId'],
				$payload['episodeId'],
				$payload['pageUrl'],
			);
			return;
		}
		if (!hash_equals($runtime->contentIdentity->contentKey, $reportedKey)) {
			throw new MessageException(
				'CONTENT_MISMATCH',
				'Reported content identity does not match the room',
				closeAfter: true,
			);
		}
	}

	private function reattachOrCreateClient(
		\OCA\PlaybackSync\WebSocket\RoomRuntime $runtime,
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
			$conn,
			$nowMs,
			$runtime->state->eventId,
			new RateLimiter($this->config->rateLimitEventsPerSec, $nowMs),
		);
		$runtime->addClient($client);
		return $client;
	}
}
