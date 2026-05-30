<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\WsConfig;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;

/**
 * Refreshes the daemon's tunable config in place from `IAppConfig`, without a
 * restart. Driven by two triggers that both end up here:
 *   - `SIGHUP` to the daemon process (`WsServe`'s signal handler).
 *   - `POST /admin/reload` on the loopback admin server (`PresenceHttpServer`).
 *
 * Only the values held on the shared `WsConfig` instance are re-read, so live
 * readers (`MessageRouter`, `Tick`, `HeartbeatHandler`, `KickController`,
 * `PresenceController`) pick the new values up on their next message. Binding
 * keys (`ws_host`/`ws_port`/`ws_admin_*`, `ws_admin_secret`) are deliberately
 * not touched — they can't be re-applied without rebinding the socket, which
 * is what a full restart is for.
 */
class ReloadController {

	public function __construct(
		private readonly WsConfig $config,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Re-read the tunables and apply them to the live `WsConfig`.
	 *
	 * @return array<string, array{from: int, to: int}> the changed tunables,
	 *         keyed by property name (empty when nothing changed)
	 */
	public function reload(): array {
		$changed = $this->config->reloadFrom($this->appConfig);
		if ($changed === []) {
			$this->logger->info('[playbacksync ws] config reload requested — no changes');
		} else {
			$this->logger->info('[playbacksync ws] config reloaded (changed: ' . implode(', ', array_keys($changed)) . ')');
		}
		return $changed;
	}
}
