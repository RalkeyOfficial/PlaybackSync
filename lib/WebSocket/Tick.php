<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use OCP\IDBConnection;
use Psr\Log\LoggerInterface;
use React\EventLoop\Loop;

/**
 * Periodic housekeeping. Every second:
 *   - Drop tombstones whose grace window has passed.
 *   - Close idle connections (no HEARTBEAT in `idleCloseMs`).
 *   - Close all connections to rooms whose database row has expired and
 *     forget the runtime.
 *
 * Every `DB_KEEPALIVE_INTERVAL_MS` it also pings the database with a trivial
 * `SELECT 1`. The daemon is long-lived but only touches the DB on JOIN /
 * playlist mutations (heartbeats are in-memory), so an otherwise-idle
 * connection gets reaped by the server's `wait_timeout` and the next
 * playlist-merge transaction dies with "MySQL server has gone away" — which
 * `JoinHandler` swallows, leaving the room with an empty playlist. The
 * keepalive keeps the connection warm so that never happens.
 *
 * Every minute, log a memory and room/connection-count snapshot at INFO so
 * operators can spot leaks without having to reach for a debugger.
 */
class Tick {

	/**
	 * How often to ping the DB to keep the connection from idling out. Well
	 * under the lowest `wait_timeout` we'd expect a managed MySQL/MariaDB to
	 * run (commonly 60-600 s behind connection poolers), at a negligible one
	 * trivial query per interval.
	 */
	private const DB_KEEPALIVE_INTERVAL_MS = 30_000;

	private int $lastMetricsLogMs = 0;
	private int $lastDbKeepaliveMs = 0;
	private ?int $lastTickMs = null;

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
		private readonly WsConfig $config,
		private readonly LoggerInterface $logger,
		private readonly IDBConnection $db,
	) {
	}

	public function start(): void {
		Loop::get()->addPeriodicTimer(1.0, function (): void {
			$this->runOnce((int)(microtime(true) * 1000));
		});
	}

	/**
	 * Wall-clock timestamp of the most recent successful `runOnce` invocation,
	 * in milliseconds. Returns `null` before the first tick — `HealthController`
	 * treats that as "loop hasn't run yet" rather than "loop is wedged".
	 */
	public function lastTickMs(): ?int {
		return $this->lastTickMs;
	}

	public function runOnce(int $nowMs): void {
		$this->lastTickMs = $nowMs;
		$this->keepDbAlive($nowMs);
		foreach ($this->registry->all() as $uuid => $runtime) {
			if ($runtime->isExpired($nowMs)) {
				foreach ($runtime->clients() as $client) {
					if ($client->conn !== null) {
						$client->conn->send($this->encoder->error('ROOM_EXPIRED', 'Room has expired', $nowMs));
						$client->conn->close();
					}
				}
				$this->registry->remove($uuid);
				$this->logger->info('[playbacksync ws] room expired uuid=' . $uuid);
				continue;
			}

			foreach ($runtime->pruneExpiredTombstones($nowMs) as $dropped) {
				$runtime->pushEnvelope([
					'ts' => $nowMs,
					'type' => 'client_left',
					'category' => 'presence',
					'actor' => 'system',
					'actorId' => null,
					'data' => ['nickname' => $dropped->nickname, 'reason' => 'tombstone_expired'],
				]);
			}
			$runtime->pruneExpiredKickBlocks($nowMs);

			foreach ($runtime->findIdleClients($nowMs, $this->config->idleCloseMs) as $idleClient) {
				if ($idleClient->conn !== null) {
					// Mark the cause so the upcoming `MessageRouter::onClose`
					// surfaces it on the resulting `client_left` envelope; the
					// default would be the generic `closed`.
					$idleClient->pendingLeaveReason = 'idle';
					$idleClient->conn->close();
				}
			}
		}

		if ($nowMs - $this->lastMetricsLogMs >= 60_000) {
			$this->lastMetricsLogMs = $nowMs;
			$this->logger->info(sprintf(
				'[playbacksync ws] heartbeat rooms=%d memMb=%.1f',
				count($this->registry->all()),
				memory_get_usage(true) / 1024 / 1024,
			));
		}
	}

	/**
	 * Ping the database every `DB_KEEPALIVE_INTERVAL_MS` so a long-idle
	 * connection never gets reaped by the server's `wait_timeout`. If the
	 * ping fails the connection is already gone, so close it — the next DB
	 * operation reconnects lazily rather than throwing on a dead socket.
	 */
	private function keepDbAlive(int $nowMs): void {
		if ($nowMs - $this->lastDbKeepaliveMs < self::DB_KEEPALIVE_INTERVAL_MS) {
			return;
		}
		$this->lastDbKeepaliveMs = $nowMs;
		try {
			$this->db->executeQuery('SELECT 1')->closeCursor();
		} catch (\Throwable $e) {
			$this->logger->warning('[playbacksync ws] DB keepalive failed, closing connection so the next query reconnects: ' . $e->getMessage());
			try {
				$this->db->close();
			} catch (\Throwable) {
				// best-effort; a failed close still lets the next query reconnect
			}
		}
	}
}
