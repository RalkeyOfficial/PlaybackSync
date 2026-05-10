<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\RoomService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IAppConfig;
use OCP\IRequest;
use OCP\Util;

class PageController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private readonly IAppConfig $appConfig,
		private readonly IInitialState $initialState,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 */
	public function index(): TemplateResponse {
		// The room creation dialog needs the configured room TTL ceiling so
		// it can validate and trim its preset list to match what the server
		// will actually accept. Pushing it via IInitialState avoids a second
		// round-trip on every page load.
		$maxTtl = $this->appConfig->getValueInt(Application::APP_ID, 'max_ttl_seconds', RoomService::MAX_TTL_SECONDS);
		if ($maxTtl < 1) {
			$maxTtl = RoomService::MAX_TTL_SECONDS;
		}
		$this->initialState->provideInitialState('roomLimits', [
			'maxTtlSeconds' => $maxTtl,
		]);

		Util::addScript('playbacksync', 'playbacksync-main');
		return new TemplateResponse('playbacksync', 'index');
	}
}
