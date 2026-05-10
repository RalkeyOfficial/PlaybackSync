<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\AppInfo;

use OCA\PlaybackSync\WebSocket\Admin\AdminAuthMiddleware;
use OCA\PlaybackSync\WebSocket\Admin\PresenceController;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\WsConfig;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\IAppConfig;
use Psr\Container\ContainerInterface;

class Application extends App implements IBootstrap {
	public const APP_ID = 'playbacksync';

	public function __construct() {
		$autoload = __DIR__ . '/../../vendor/autoload.php';
		if (file_exists($autoload)) {
			require_once $autoload;
		}

		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
		// WsConfig is a snapshot of IAppConfig values; build it via factory so
		// the int constructor params don't trip up auto-wiring.
		$context->registerService(WsConfig::class, static function (ContainerInterface $c): WsConfig {
			return WsConfig::fromAppConfig($c->get(IAppConfig::class));
		});

		$context->registerService(RoomRegistry::class, static function (ContainerInterface $c): RoomRegistry {
			return new RoomRegistry($c->get(WsConfig::class)->eventLogSize);
		});

		// PresenceController takes its per-room client cap from WsConfig so
		// the daemon's view stays consistent with `max_clients_per_room`.
		$context->registerService(PresenceController::class, static function (ContainerInterface $c): PresenceController {
			return new PresenceController(
				$c->get(RoomRegistry::class),
				$c->get(WsConfig::class)->maxClientsPerRoom,
			);
		});

		// AdminAuthMiddleware needs the configured shared secret. We read it
		// here rather than in WsConfig because (a) it's not a hot-path tunable
		// and (b) WsConfig is also instantiated in PHP-FPM contexts where the
		// admin server isn't relevant.
		$context->registerService(AdminAuthMiddleware::class, static function (ContainerInterface $c): AdminAuthMiddleware {
			$cfg = $c->get(IAppConfig::class);
			$secret = $cfg->getValueString(self::APP_ID, 'ws_admin_secret', '');
			return new AdminAuthMiddleware($secret);
		});
	}

	public function boot(IBootContext $context): void {
	}
}
