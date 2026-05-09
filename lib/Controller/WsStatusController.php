<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IAppConfig;
use OCP\IRequest;
use Ratchet\MessageComponentInterface;

/**
 * Tells callers whether the WebSocket sync service is installed and
 * configured on this Nextcloud instance.
 *
 * This is an *installation* check, not a liveness probe. It answers
 * "does the admin claim WS sync exists here?" — useful for the frontend
 * to decide whether to expose sync UI at all. Whether the daemon
 * process is currently up is something the client learns when it tries
 * to open the WebSocket; this endpoint deliberately doesn't reach
 * across the network because in containerised setups the PHP process
 * can't reliably reach the daemon's bind address anyway.
 */
class WsStatusController extends Controller {

	public function __construct(
		string $appName,
		IRequest $request,
		private IAppConfig $appConfig,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		return new DataResponse(['available' => $this->isAvailable()]);
	}

	private function isAvailable(): bool {
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
}
