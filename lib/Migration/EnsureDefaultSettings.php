<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Migration;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Settings\SettingsDefaults;
use OCP\IAppConfig;
use OCP\Migration\IOutput;
use OCP\Migration\IRepairStep;

/**
 * Seed PlaybackSync's `IAppConfig` keys with their default values on first
 * install (and idempotently on subsequent upgrades). Once this step has run,
 * every reader can trust the keys are present without carrying an inline
 * fallback.
 *
 * Only *absent* keys are written — admins who have already tuned a value see
 * their setting preserved. Existing installs that upgrade past this step
 * quietly gain whichever keys they were missing.
 */
class EnsureDefaultSettings implements IRepairStep {

	public function __construct(
		private readonly IAppConfig $appConfig,
	) {
	}

	public function getName(): string {
		return 'Ensure PlaybackSync default settings are seeded';
	}

	public function run(IOutput $output): void {
		$app = Application::APP_ID;
		$seeded = 0;

		foreach (SettingsDefaults::INT_DEFAULTS as $key => $value) {
			if (!$this->appConfig->hasKey($app, $key)) {
				$this->appConfig->setValueInt($app, $key, $value);
				$seeded++;
			}
		}

		foreach (SettingsDefaults::STRING_DEFAULTS as $key => $value) {
			if (!$this->appConfig->hasKey($app, $key)) {
				$this->appConfig->setValueString($app, $key, $value);
				$seeded++;
			}
		}

		foreach (SettingsDefaults::BOOL_DEFAULTS as $key => $value) {
			if (!$this->appConfig->hasKey($app, $key)) {
				$this->appConfig->setValueBool($app, $key, $value);
				$seeded++;
			}
		}

		if ($seeded > 0) {
			$output->info(sprintf('PlaybackSync seeded %d default setting(s).', $seeded));
		} else {
			$output->info('PlaybackSync defaults already present — leaving in place.');
		}
	}
}
