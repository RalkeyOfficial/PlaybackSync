<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\HealthClient;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IAppConfig;
use OCP\IRequest;
use Ratchet\MessageComponentInterface;

/**
 * Tells callers whether the WebSocket sync service is *usable* on this
 * Nextcloud instance — meaning installed, configured, AND the daemon
 * process is currently reachable from PHP.
 *
 * The response carries a `reason` field alongside `available` so the UI
 * can distinguish "admin hasn't set this up yet" from "admin set it up
 * but the daemon is currently down". Those two surface different help
 * affordances:
 *   - `not_installed` → link to the install instructions.
 *   - `not_running`   → tell the user a sysadmin needs to start it.
 *
 * The probe goes via `HealthClient` (loopback to the daemon's `/healthz`)
 * so this endpoint shares the same reachability semantics as
 * `/api/v1/health`. Failure modes (timeout, daemon down, daemon answers
 * but reports `degraded`) all collapse to `not_running` — anything beyond
 * that is the operator's job to dig out of the logs.
 */
class WsStatusController extends Controller {

	public const REASON_NOT_INSTALLED = 'not_installed';
	public const REASON_NOT_RUNNING = 'not_running';

	public function __construct(
		string $appName,
		IRequest $request,
		private readonly IAppConfig $appConfig,
		private readonly HealthClient $healthClient,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		if (!$this->isInstalled()) {
			return new DataResponse([
				'available' => false,
				'reason' => self::REASON_NOT_INSTALLED,
			]);
		}

		if (!$this->isDaemonReachable()) {
			return new DataResponse([
				'available' => false,
				'reason' => self::REASON_NOT_RUNNING,
			]);
		}

		return new DataResponse([
			'available' => true,
			'reason' => null,
		]);
	}

	private function isInstalled(): bool {
		// Composer deps for the daemon must have been installed. The class
		// is loaded by the autoload require_once in Application::__construct.
		if (!interface_exists(MessageComponentInterface::class)) {
			return false;
		}

		// Configuration keys must be present and non-default-empty. They
		// have built-in defaults so this is essentially a hedge against
		// an admin who explicitly set them to empty values.
		$host = $this->appConfig->getValueString(Application::APP_ID, 'ws_host', '');
		$port = $this->appConfig->getValueInt(Application::APP_ID, 'ws_port', 0);
		if ($host === '' || $port <= 0) {
			return false;
		}

		return true;
	}

	private function isDaemonReachable(): bool {
		$probe = $this->healthClient->fetch();
		if ($probe['reachable'] !== true) {
			return false;
		}
		// Reachable but the daemon's own status isn't `ok` — the housekeeping
		// loop is wedged or similar. Treat the same as unreachable for the
		// purposes of "can I rely on sync right now" — operator chases the
		// detail through `/api/v1/health` or the daemon log.
		$body = $probe['body'];
		return isset($body['status']) && $body['status'] === 'ok';
	}
}
