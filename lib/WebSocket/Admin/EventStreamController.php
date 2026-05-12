<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\RoomRegistry;
use Ratchet\ConnectionInterface;
use React\EventLoop\Loop;
use React\EventLoop\LoopInterface;
use React\EventLoop\TimerInterface;
use SplObjectStorage;

/**
 * SSE streamer for the daemon's loopback admin port. Owns per-connection
 * subscriber + heartbeat state so the consumer side cleans up when the
 * underlying socket closes.
 *
 * One instance lives for the lifetime of the daemon. Single-threaded React
 * event loop means no locking needed — every callback runs on the same
 * thread that owns the side-table.
 */
class EventStreamController {

	private const HEARTBEAT_INTERVAL_SECONDS = 25.0;

	/**
	 * Per-connection cleanup record.
	 *
	 * @var SplObjectStorage<ConnectionInterface, array{
	 *   unsubscribe: callable(): void,
	 *   heartbeat: TimerInterface
	 * }>
	 */
	private SplObjectStorage $subscriptions;

	private int $daemonStartedAtMs = 0;
	private ?LoopInterface $loop;

	public function __construct(
		private readonly RoomRegistry $registry,
	) {
		$this->subscriptions = new SplObjectStorage();
		$this->loop = null;
	}

	/**
	 * Wire the start-of-process timestamp. Same pattern as `HealthController`:
	 * `WsServe::execute()` calls this with the captured boot moment so the
	 * value reflects the daemon, not whenever the DI container resolved us.
	 */
	public function setDaemonStartedAtMs(int $startedAtMs): void {
		$this->daemonStartedAtMs = $startedAtMs;
	}

	/**
	 * Start an SSE stream for a single room over the given Ratchet connection.
	 * Writes the HTTP preamble + meta record + buffered backfill, then
	 * registers a live subscriber and a heartbeat timer.
	 *
	 * The connection stays open; cleanup happens in `closeStream()` when the
	 * outer HTTP server signals close.
	 */
	public function openRoomStream(ConnectionInterface $conn, string $uuid, ?int $lastEventId): void {
		$this->writePreamble($conn);

		$runtime = $this->registry->find($uuid);
		$since = $lastEventId ?? 0;
		$backfill = $runtime?->envelopesSince($since) ?? [];

		$this->writeRecord($conn, 'meta', [
			'daemonStartedAtMs' => $this->daemonStartedAtMs,
			'backfilledFromId' => $since,
			'backfillCount' => count($backfill),
		]);

		foreach ($backfill as $env) {
			$this->writeEvent($conn, $env);
		}

		$unsubscribe = $this->registry->subscribeRoom($uuid, function (array $env) use ($conn): void {
			$this->writeEvent($conn, $env);
		});

		$loop = $this->loop ?? Loop::get();
		$heartbeat = $loop->addPeriodicTimer(
			self::HEARTBEAT_INTERVAL_SECONDS,
			static function () use ($conn): void {
				$conn->send(": keepalive\n\n");
			},
		);

		$this->subscriptions[$conn] = [
			'unsubscribe' => $unsubscribe,
			'heartbeat' => $heartbeat,
		];
	}

	/**
	 * Start an SSE stream of every envelope published anywhere in the daemon
	 * (cross-room admin feed). Uses `RoomRegistry::mergedEventsSince` for the
	 * initial backfill so the admin viewer sees the full chronological tail
	 * across every room plus the cross-room ring.
	 *
	 * Cleanup is the same as `openRoomStream` — `closeStream()` cancels both
	 * the global subscription and the heartbeat when the socket closes.
	 */
	public function openGlobalStream(ConnectionInterface $conn, ?int $lastEventId): void {
		$this->writePreamble($conn);

		$since = $lastEventId ?? 0;
		$backfill = $this->registry->mergedEventsSince($since);

		$this->writeRecord($conn, 'meta', [
			'daemonStartedAtMs' => $this->daemonStartedAtMs,
			'backfilledFromId' => $since,
			'backfillCount' => count($backfill),
		]);

		foreach ($backfill as $env) {
			$this->writeEvent($conn, $env);
		}

		$unsubscribe = $this->registry->subscribeGlobal(function (array $env) use ($conn): void {
			$this->writeEvent($conn, $env);
		});

		$loop = $this->loop ?? Loop::get();
		$heartbeat = $loop->addPeriodicTimer(
			self::HEARTBEAT_INTERVAL_SECONDS,
			static function () use ($conn): void {
				$conn->send(": keepalive\n\n");
			},
		);

		$this->subscriptions[$conn] = [
			'unsubscribe' => $unsubscribe,
			'heartbeat' => $heartbeat,
		];
	}

	/**
	 * Cancel the per-connection subscription and heartbeat. Idempotent — safe
	 * to call from `PresenceHttpServer::onClose()` even if the stream was
	 * never opened on this connection.
	 */
	public function closeStream(ConnectionInterface $conn): void {
		if (!$this->subscriptions->contains($conn)) {
			return;
		}
		$entry = $this->subscriptions[$conn];
		try {
			($entry['unsubscribe'])();
		} catch (\Throwable) {
			// Unsubscribe is best-effort.
		}
		$loop = $this->loop ?? Loop::get();
		$loop->cancelTimer($entry['heartbeat']);
		$this->subscriptions->detach($conn);
	}

	/**
	 * For tests: inject a loop so timer scheduling can be observed without
	 * spinning up the real React loop.
	 */
	public function setLoop(LoopInterface $loop): void {
		$this->loop = $loop;
	}

	private function writePreamble(ConnectionInterface $conn): void {
		$preamble = "HTTP/1.1 200 OK\r\n"
			. "Content-Type: text/event-stream\r\n"
			. "Cache-Control: no-store\r\n"
			. "X-Accel-Buffering: no\r\n"
			. "Connection: close\r\n"
			. "\r\n";
		$conn->send($preamble);
	}

	private function writeEvent(ConnectionInterface $conn, array $envelope): void {
		$id = $envelope['id'] ?? 0;
		$json = json_encode($envelope, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if ($json === false) {
			return;
		}
		$conn->send('id: ' . $id . "\nevent: event\ndata: " . $json . "\n\n");
	}

	/**
	 * Write a non-event SSE record (e.g. `meta`). No `id:` line so it doesn't
	 * advance the consumer's `Last-Event-ID`.
	 */
	private function writeRecord(ConnectionInterface $conn, string $event, array $payload): void {
		$json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if ($json === false) {
			return;
		}
		$conn->send('event: ' . $event . "\ndata: " . $json . "\n\n");
	}
}
