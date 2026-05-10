<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\Tick;

/**
 * Handles `GET /healthz` on the loopback admin server.
 *
 * Pure value transform around `RoomRegistry` + `Tick` — no I/O, no Ratchet.
 * Returns aggregate counters and timings only; never room UUIDs, client IDs,
 * IPs, secrets, or event-log content. The endpoint is unauthenticated, so
 * everything in the response must be safe to expose to anyone who can reach
 * the loopback admin port (or the PHP `/api/v1/health` passthrough).
 */
class HealthController {

	/**
	 * Allow up to five tick intervals (5 s) of slack before flagging the loop
	 * as stuck. Generous enough to absorb a logger I/O hiccup, tight enough
	 * that a wedged process surfaces in the next probe.
	 */
	public const TICK_FRESHNESS_MS = 5_000;

	public function __construct(
		private readonly RoomRegistry $registry,
		private readonly Tick $tick,
		private readonly string $daemonVersion,
		private readonly int $startedAtMs,
	) {
	}

	/**
	 * Build the `/healthz` JSON body.
	 *
	 * @return array{
	 *     status: string,
	 *     daemon_version: string,
	 *     uptime_seconds: int,
	 *     timestamp_ms: int,
	 *     rooms: array{active: int},
	 *     clients: array{connected: int},
	 *     tick: array{running: bool, last_tick_ms_ago: int|null}
	 * }
	 */
	public function health(int $nowMs): array {
		$rooms = $this->registry->all();
		$connected = 0;
		foreach ($rooms as $runtime) {
			$connected += $runtime->clientCount();
		}

		$lastTickMs = $this->tick->lastTickMs();
		$lastTickMsAgo = $lastTickMs === null ? null : max(0, $nowMs - $lastTickMs);
		$tickRunning = $lastTickMsAgo !== null && $lastTickMsAgo < self::TICK_FRESHNESS_MS;

		$uptimeSeconds = max(0, intdiv($nowMs - $this->startedAtMs, 1000));

		return [
			'status' => 'ok',
			'daemon_version' => $this->daemonVersion,
			'uptime_seconds' => $uptimeSeconds,
			'timestamp_ms' => $nowMs,
			'rooms' => ['active' => count($rooms)],
			'clients' => ['connected' => $connected],
			'tick' => [
				'running' => $tickRunning,
				'last_tick_ms_ago' => $lastTickMsAgo,
			],
		];
	}
}
