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

	public function runOnce(int $nowMs): void {
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

			$runtime->pruneExpiredTombstones($nowMs);
			$runtime->pruneExpiredKickBlocks($nowMs);

			foreach ($runtime->findIdleClients($nowMs, $this->config->idleCloseMs) as $idleClient) {
				if ($idleClient->conn !== null) {
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
