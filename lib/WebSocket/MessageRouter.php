<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use OCA\PlaybackSync\WebSocket\Handler\BufferHandler;
use OCA\PlaybackSync\WebSocket\Handler\ClockHandler;
use OCA\PlaybackSync\WebSocket\Handler\CursorChangeHandler;
use OCA\PlaybackSync\WebSocket\Handler\EventHandler;
use OCA\PlaybackSync\WebSocket\Handler\HeartbeatHandler;
use OCA\PlaybackSync\WebSocket\Handler\JoinHandler;
use OCA\PlaybackSync\WebSocket\Handler\PlaylistUpdateHandler;
use Psr\Log\LoggerInterface;
use Ratchet\ConnectionInterface;
use Ratchet\MessageComponentInterface;
use React\EventLoop\Loop;
use SplObjectStorage;
use Throwable;

/**
 * Single fan-in for every connection. Parses the URL on `onOpen`, validates
 * incoming JSON, and dispatches by message type to the right handler. Owns
 * the per-connection JOIN-timeout timer and the tombstoning logic that fires
 * on socket close.
 *
 * Per-connection state is held in a side-table (SplObjectStorage) keyed by
 * the `ConnectionInterface` instance — this avoids attaching dynamic
 * properties to a class we don't own and survives PHP 8.4's stricter
 * dynamic-property rules.
 */
class MessageRouter implements MessageComponentInterface {

	private const ALLOWED_UUID_PATTERN = '/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/';

	/** @var SplObjectStorage<ConnectionInterface, ConnectionContext> */
	private SplObjectStorage $contexts;

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageValidator $validator,
		private readonly MessageEncoder $encoder,
		private readonly JoinHandler $joinHandler,
		private readonly EventHandler $eventHandler,
		private readonly CursorChangeHandler $cursorHandler,
		private readonly PlaylistUpdateHandler $playlistHandler,
		private readonly HeartbeatHandler $heartbeatHandler,
		private readonly ClockHandler $clockHandler,
		private readonly BufferHandler $bufferHandler,
		private readonly WsConfig $config,
		private readonly LoggerInterface $logger,
	) {
		$this->contexts = new SplObjectStorage();
	}

	public function onOpen(ConnectionInterface $conn): void {
		$uuid = $this->extractRoomUuid($conn);
		if ($uuid === null) {
			$this->sendErrorAndClose($conn, 'ROOM_NOT_FOUND', 'Malformed or missing room UUID in URL');
			return;
		}

		$ctx = new ConnectionContext($uuid);
		$this->contexts->attach($conn, $ctx);

		$ctx->joinTimer = Loop::get()->addTimer(
			$this->config->joinTimeoutMs / 1000.0,
			function () use ($conn, $ctx): void {
				if (!$ctx->joined) {
					$this->logger->info('[playbacksync ws] join timeout');
					$this->sendErrorAndClose($conn, 'JOIN_TIMEOUT', 'No JOIN within ' . $this->config->joinTimeoutMs . 'ms');
				}
			},
		);

		$this->logger->info('[playbacksync ws] open uuid=' . $uuid);
	}

	public function onMessage(ConnectionInterface $from, $msg): void {
		$ctx = $this->contexts[$from] ?? null;
		if ($ctx === null) {
			$from->close();
			return;
		}

		$nowMs = (int)(microtime(true) * 1000);

		try {
			$envelope = $this->validator->parse((string)$msg);
			$type = (string)$envelope['type'];

			match ($type) {
				'JOIN' => $this->joinHandler->handle($from, $ctx, $this->validator->validateJoin($envelope), $nowMs),
				'EVENT' => $this->eventHandler->handle($from, $ctx, $this->validator->validateEvent($envelope), $nowMs),
				'CURSOR_CHANGE_REQUEST' => $this->cursorHandler->handle($from, $ctx, $this->validator->validateCursorChangeRequest($envelope), $nowMs),
				'PLAYLIST_UPDATE' => $this->playlistHandler->handle($from, $ctx, $this->validator->validatePlaylistUpdate($envelope), $nowMs),
				'HEARTBEAT' => $this->heartbeatHandler->handle($from, $ctx, $this->validator->validateHeartbeat($envelope), $nowMs),
				'CLOCK_PING' => $this->clockHandler->handle($from, $ctx, $this->validator->validateClockPing($envelope), $nowMs),
				'BUFFER_START' => $this->bufferHandler->handleStart($from, $ctx, $this->validator->validateBuffer($envelope), $nowMs),
				'BUFFER_END' => $this->bufferHandler->handleEnd($from, $ctx, $this->validator->validateBuffer($envelope), $nowMs),
				default => throw new MessageException(MessageValidator::ERR_UNKNOWN_TYPE, 'Unknown message type: ' . $type),
			};
		} catch (MessageException $e) {
			$this->logger->info('[playbacksync ws] error code=' . $e->errorCode . ' msg=' . $e->getMessage());
			$from->send($this->encoder->error($e->errorCode, $e->getMessage(), $nowMs));
			if ($e->closeAfter) {
				$from->close();
			}
		} catch (Throwable $e) {
			$this->logger->error('[playbacksync ws] handler crash', ['exception' => $e]);
			$from->send($this->encoder->error('INTERNAL_ERROR', 'Internal server error', $nowMs));
			$from->close();
		}
	}

	public function onClose(ConnectionInterface $conn): void {
		$ctx = $this->contexts[$conn] ?? null;
		if ($ctx === null) {
			return;
		}
		$this->contexts->detach($conn);
		if ($ctx->joinTimer !== null) {
			Loop::get()->cancelTimer($ctx->joinTimer);
			$ctx->joinTimer = null;
		}

		// Tombstone the runtime client so a quick reconnect can resume.
		if ($ctx->clientId !== null) {
			$runtime = $this->registry->find($ctx->roomUuid);
			$client = $runtime?->getClient($ctx->clientId);
			if ($client !== null) {
				$nowMs = (int)(microtime(true) * 1000);
				$reason = $client->pendingLeaveReason ?? 'closed';
				$client->pendingLeaveReason = null;
				$client->tombstone($nowMs + $this->config->tombstoneMs);
				$runtime?->pushEnvelope([
					'ts' => $nowMs,
					'type' => 'client_left',
					'category' => 'presence',
					'actor' => 'system',
					'actorId' => null,
					'data' => ['nickname' => $client->nickname, 'reason' => $reason],
				]);
			}
		}

		$this->logger->info('[playbacksync ws] close uuid=' . $ctx->roomUuid);
	}

	public function onError(ConnectionInterface $conn, Throwable $e): void {
		$this->logger->warning('[playbacksync ws] socket error: ' . $e->getMessage());
		$conn->close();
	}

	private function extractRoomUuid(ConnectionInterface $conn): ?string {
		// Ratchet's WsConnection attaches the upgrade request as a dynamic
		// property. `property_exists` doesn't see dynamic props, so we read
		// it directly with a null fallback.
		/** @phpstan-ignore-next-line */
		$req = $conn->httpRequest ?? null;
		if ($req === null || !method_exists($req, 'getUri')) {
			return null;
		}
		$path = (string)$req->getUri()->getPath();
		// Accept both `/{uuid}` and `/apps/playbacksync/ws/{uuid}` (last segment wins).
		$segments = array_values(array_filter(explode('/', $path), static fn (string $s): bool => $s !== ''));
		$last = end($segments);
		if (!is_string($last) || preg_match(self::ALLOWED_UUID_PATTERN, $last) !== 1) {
			return null;
		}
		return strtolower($last);
	}

	private function sendErrorAndClose(ConnectionInterface $conn, string $code, string $message): void {
		$conn->send($this->encoder->error($code, $message, (int)(microtime(true) * 1000)));
		$conn->close();
	}
}
