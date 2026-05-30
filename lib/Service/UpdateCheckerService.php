<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Checks the project's GitHub releases for a version newer than the one
 * installed, and remembers the answer in `IAppConfig`.
 *
 * PlaybackSync ships from GitHub rather than the Nextcloud App Store, so the
 * built-in app-update machinery never sees it. This service is the stand-in:
 * it asks the GitHub "latest release" API for the newest published tag and
 * compares it to the installed version. It only ever *reports* — it never
 * downloads or installs anything. The result is cached so the admin UI can
 * render a status without making a network call on every page load.
 */
class UpdateCheckerService {

	private const LATEST_RELEASE_API = 'https://api.github.com/repos/RalkeyOfficial/PlaybackSync/releases/latest';

	/** Fallback link when no release has been fetched yet (or it carried no URL). */
	private const RELEASES_PAGE = 'https://github.com/RalkeyOfficial/PlaybackSync/releases';

	// A GitHub round-trip is not latency-critical (it runs from a daily job or a
	// deliberate admin click), so we can afford a generous ceiling rather than
	// the sub-second budget the loopback daemon clients use.
	public const REQUEST_TIMEOUT_SECONDS = 10.0;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly IAppConfig $appConfig,
		private readonly IAppManager $appManager,
		private readonly ITimeFactory $time,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Hit the GitHub API, persist the newest known version on success, and
	 * return the resulting status. Network or parse failures are swallowed and
	 * logged — the cached status is returned unchanged so a flaky check never
	 * surfaces as an error to the caller.
	 *
	 * @return array{enabled: bool, currentVersion: string, latestVersion: ?string, updateAvailable: bool, releaseUrl: string, lastCheckedAt: ?int}
	 */
	public function check(): array {
		try {
			$response = $this->clientService->newClient()->get(self::LATEST_RELEASE_API, [
				'headers' => [
					'Accept' => 'application/vnd.github+json',
					// GitHub rejects API requests without a User-Agent with 403.
					'User-Agent' => 'PlaybackSync/' . $this->installedVersion(),
				],
				'timeout' => self::REQUEST_TIMEOUT_SECONDS,
				'connect_timeout' => self::REQUEST_TIMEOUT_SECONDS,
				// Read the status ourselves rather than letting Guzzle throw — a
				// 403 (rate limit) or 404 (no releases yet) is informational, not
				// exceptional.
				'http_errors' => false,
			]);

			$status = $response->getStatusCode();
			if ($status !== 200) {
				$this->logger->warning('PlaybackSync update check got unexpected status from GitHub', [
					'status' => $status,
				]);
				return $this->status();
			}

			$body = json_decode((string)$response->getBody(), true);
			$tag = is_array($body) && is_string($body['tag_name'] ?? null) ? $body['tag_name'] : '';
			if ($tag === '') {
				$this->logger->warning('PlaybackSync update check: GitHub response carried no tag_name');
				return $this->status();
			}

			$app = Application::APP_ID;
			$this->appConfig->setValueString($app, 'update_latest_version', $this->normalize($tag));
			$url = is_array($body) && is_string($body['html_url'] ?? null) ? $body['html_url'] : '';
			if ($url !== '') {
				$this->appConfig->setValueString($app, 'update_latest_url', $url);
			}
			$this->appConfig->setValueInt($app, 'update_last_checked_at', $this->time->getTime());
		} catch (Throwable $e) {
			$this->logger->warning('PlaybackSync update check failed', ['exception' => $e]);
		}

		return $this->status();
	}

	/**
	 * Build the current update status purely from cached config — no network.
	 * `latestVersion` and `lastCheckedAt` are null until the first successful
	 * check has run.
	 *
	 * @return array{enabled: bool, currentVersion: string, latestVersion: ?string, updateAvailable: bool, releaseUrl: string, lastCheckedAt: ?int}
	 */
	public function status(): array {
		$app = Application::APP_ID;
		$current = $this->installedVersion();
		$latest = $this->appConfig->getValueString($app, 'update_latest_version', '');
		$url = $this->appConfig->getValueString($app, 'update_latest_url', '');
		$checkedAt = $this->appConfig->getValueInt($app, 'update_last_checked_at', 0);

		return [
			'enabled' => $this->appConfig->getValueBool($app, 'update_check_enabled', true),
			'currentVersion' => $current,
			'latestVersion' => $latest === '' ? null : $latest,
			'updateAvailable' => $latest !== '' && version_compare($latest, $current, '>'),
			'releaseUrl' => $url !== '' ? $url : self::RELEASES_PAGE,
			'lastCheckedAt' => $checkedAt === 0 ? null : $checkedAt,
		];
	}

	/** The installed app version, as declared in `appinfo/info.xml`. */
	private function installedVersion(): string {
		return $this->appManager->getAppVersion(Application::APP_ID);
	}

	/**
	 * Strip a single leading `v`/`V` from a GitHub tag so it compares cleanly
	 * against the bare semver in `info.xml` (e.g. `v1.2.0` → `1.2.0`).
	 *
	 * @param string $tag the raw `tag_name` from the GitHub API
	 * @return string the tag normalised to a bare version string
	 */
	private function normalize(string $tag): string {
		$trimmed = trim($tag);
		if ($trimmed !== '' && ($trimmed[0] === 'v' || $trimmed[0] === 'V')) {
			return substr($trimmed, 1);
		}
		return $trimmed;
	}
}
