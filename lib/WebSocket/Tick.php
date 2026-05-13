<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use Psr\Log\LoggerInterface;
use React\EventLoop\Loop;

/**
 * Periodic housekeeping. Every second:
 *   - Drop tombstones whose grace window has passed.
 *   - Close idle connections (no HEARTBEAT in `idleCloseMs`).
 *   - Close all connections to rooms whose database row has expired and
 *     forget the runtime.
 *
 * Every minute, log a memory and room/connection-count snapshot at INFO so
 * operators can spot leaks without having to reach for a debugger.
 */
class Tick {

	private int $lastMetricsLogMs = 0;
	private ?int $lastTickMs = null;

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly MessageEncoder $encoder,
		private readonly WsConfig $config,
		private readonly LoggerInterface $logger,
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
}
