<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\BackgroundJob;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\UpdateCheckerService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use OCP\IAppConfig;

/**
 * Once a day, ask GitHub whether a newer PlaybackSync release exists and cache
 * the answer for the admin settings page. Mirrors Nextcloud's own daily
 * update-notification cadence; a daily check stays comfortably inside GitHub's
 * unauthenticated rate limit. Honours the `update_check_enabled` toggle so an
 * admin can switch the outbound call off entirely.
 */
class CheckUpdatesJob extends TimedJob {

	private const INTERVAL_SECONDS = 86_400;

	public function __construct(
		ITimeFactory $time,
		private readonly UpdateCheckerService $checker,
		private readonly IAppConfig $appConfig,
	) {
		parent::__construct($time);
		$this->setInterval(self::INTERVAL_SECONDS);
	}

	protected function run($argument): void {
		if (!$this->appConfig->getValueBool(Application::APP_ID, 'update_check_enabled', true)) {
			return;
		}
		$this->checker->check();
	}
}
