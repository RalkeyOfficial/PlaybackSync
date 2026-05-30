<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Migration;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\AdminRestartClient;
use OCP\IAppConfig;
use OCP\Migration\IOutput;
use OCP\Migration\IRepairStep;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * After an app upgrade, ask the running WebSocket daemon to restart so it loads
 * the freshly-deployed daemon code. A reload (`SIGHUP`) would only re-read
 * config — it keeps the old code running — so an upgrade specifically needs a
 * restart, which the supervisor turns into a brand-new process.
 *
 * Registered under `<post-migration>` only: a fresh install has no prior daemon
 * to bounce, and the daemon isn't started until an admin sets it up. The step
 * is strictly best-effort — a stopped or unsupervised daemon (dev boxes, hosts
 * without a supervisor, installs that never enabled sync) must never make
 * `occ upgrade` fail, so every failure is logged and swallowed.
 */
class RestartDaemonOnUpgrade implements IRepairStep {

	public function __construct(
		private readonly AdminRestartClient $restartClient,
		private readonly IAppConfig $appConfig,
		private readonly LoggerInterface $logger,
	) {
	}

	public function getName(): string {
		return 'Restart the PlaybackSync WebSocket daemon to load upgraded code';
	}

	public function run(IOutput $output): void {
		// No admin secret means the daemon was never configured/run on this
		// install — there is nothing to restart, and AdminRestartClient would
		// only throw on the missing secret anyway.
		$secret = $this->appConfig->getValueString(Application::APP_ID, 'ws_admin_secret', '');
		if ($secret === '') {
			$output->info('PlaybackSync daemon not configured yet — skipping restart.');
			return;
		}

		try {
			$this->restartClient->restart();
			$output->info('PlaybackSync WebSocket daemon restart requested — it will come back on the upgraded code.');
		} catch (Throwable $e) {
			$this->logger->info('PlaybackSync daemon restart on upgrade skipped: ' . $e->getMessage());
			$output->info('PlaybackSync WebSocket daemon not reachable — it will load the new code on its next start.');
		}
	}
}
