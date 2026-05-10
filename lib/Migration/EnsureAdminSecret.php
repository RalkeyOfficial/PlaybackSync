<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Migration;

use OCA\PlaybackSync\Service\AdminSecretService;
use OCP\Migration\IOutput;
use OCP\Migration\IRepairStep;

/**
 * Generate the daemon's admin HTTP shared secret on app install / upgrade if
 * it isn't already set.
 *
 * The secret has no UX value — it just lets the PHP request layer prove to the
 * daemon that the call came from the same Nextcloud instance — so making the
 * admin run `openssl rand` by hand would be friction with no upside. We seed
 * a 256-bit hex value via `random_bytes()` once, persist it in `IAppConfig`
 * (sensitive flag set), and never touch it again.
 *
 * Idempotent by construction: if the secret already has a value, this step
 * is a no-op. Operators can rotate by clearing the config key and running
 * `occ maintenance:repair` (or just `occ upgrade`).
 */
class EnsureAdminSecret implements IRepairStep {

	public function __construct(
		private readonly AdminSecretService $secrets,
	) {
	}

	public function getName(): string {
		return 'Ensure PlaybackSync WebSocket admin secret exists';
	}

	public function run(IOutput $output): void {
		if ($this->secrets->ensureExists()) {
			$output->info('PlaybackSync admin secret generated and stored.');
		} else {
			$output->info('PlaybackSync admin secret already configured — leaving in place.');
		}
	}
}
