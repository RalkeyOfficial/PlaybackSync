<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Http\SseStreamResponse;
use OCA\PlaybackSync\Service\AdminEventClient;
use OCA\PlaybackSync\Service\AdminReloadClient;
use OCA\PlaybackSync\Service\AdminRestartClient;
use OCA\PlaybackSync\Service\AdminSecretService;
use OCA\PlaybackSync\Service\Exceptions\DaemonReloadFailedException;
use OCA\PlaybackSync\Service\Exceptions\DaemonRestartFailedException;
use OCA\PlaybackSync\Service\UpdateCheckerService;
use OCA\PlaybackSync\Settings\SettingsDefaults;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\Response;
use OCP\IAppConfig;
use OCP\IRequest;

/**
 * Admin-only REST surface for the PlaybackSync administration settings
 * page. Default attribute behavior (no `#[NoAdminRequired]`, no
 * `#[NoCSRFRequired]`) means the Nextcloud middleware enforces admin auth
 * and CSRF for every endpoint here — we don't double-check.
 */
class AdminSettingsController extends Controller {

	/**
	 * Inclusive numeric validation rules.
	 *
	 * @var array<string, array{min: int, max: int}>
	 */
	private const INT_RULES = [
		'ws_join_timeout_ms' => ['min' => 0, 'max' => 600_000],
		'ws_idle_close_ms' => ['min' => 0, 'max' => 600_000],
		'ws_tombstone_ms' => ['min' => 0, 'max' => 600_000],
		'ws_kick_block_ms' => ['min' => 0, 'max' => 600_000],
		'ws_event_log_size' => ['min' => 1, 'max' => 10_000],
		'ws_rate_limit_events_per_sec' => ['min' => 1, 'max' => 1_000],
		'ws_drift_nudge_threshold_ms' => ['min' => 0, 'max' => 60_000],
		'ws_drift_seek_threshold_ms' => ['min' => 0, 'max' => 60_000],
		'ws_drift_cooldown_ms' => ['min' => 0, 'max' => 60_000],
		'ws_port' => ['min' => 1, 'max' => 65_535],
		'ws_admin_port' => ['min' => 1, 'max' => 65_535],
		'default_ttl_seconds' => ['min' => 1, 'max' => 2_592_000],
		'max_ttl_seconds' => ['min' => 60, 'max' => 2_592_000],
		'max_clients_per_room' => ['min' => 1, 'max' => 1_000],
	];

	private const HOST_REGEX = '/^[A-Za-z0-9._:\-]+$/';

	public function __construct(
		string $appName,
		IRequest $request,
		private ?string $userId,
		private readonly IAppConfig $appConfig,
		private readonly AdminSecretService $secrets,
		private readonly AdminEventClient $eventClient,
		private readonly AdminRestartClient $restartClient,
		private readonly AdminReloadClient $reloadClient,
		private readonly UpdateCheckerService $updateChecker,
	) {
		parent::__construct($appName, $request);
	}

	public function index(): DataResponse {
		return new DataResponse($this->snapshot());
	}

	/**
	 * Persist a partial patch of admin settings. The payload is a flat map
	 * keyed by config key; unknown keys and out-of-range values are rejected
	 * with `400 Bad Request` and no values are written.
	 *
	 * @param array<string, mixed> $values flat config-key → new-value map.
	 */
	public function update(array $values = []): DataResponse {
		try {
			$normalized = $this->validate($values);
		} catch (\InvalidArgumentException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}

		// Cross-field check: default TTL can't exceed max TTL once both
		// are settled (whether from the patch or from the existing config).
		$effectiveMax = $normalized['max_ttl_seconds']
			?? $this->appConfig->getValueInt(Application::APP_ID, 'max_ttl_seconds', SettingsDefaults::INT_DEFAULTS['max_ttl_seconds']);
		$effectiveDefault = $normalized['default_ttl_seconds']
			?? $this->appConfig->getValueInt(Application::APP_ID, 'default_ttl_seconds', SettingsDefaults::INT_DEFAULTS['default_ttl_seconds']);
		if ($effectiveDefault > $effectiveMax) {
			return new DataResponse(
				['error' => 'default_ttl_seconds must not exceed max_ttl_seconds.'],
				Http::STATUS_BAD_REQUEST,
			);
		}

		// Capture before/after so the event log can show *what* changed, not
		// just *which keys* were posted. Strict !== so a typed mismatch (e.g.
		// "8765" vs 8765) still registers — the validator normalises both
		// sides to the same type so this is purely defensive.
		$changes = [];
		foreach ($normalized as $key => $value) {
			$before = $this->readCurrentValue($key);
			$this->persist($key, $value);
			if ($before !== $value) {
				$changes[] = ['key' => $key, 'from' => $before, 'to' => $value];
			}
		}

		$this->eventClient->record(
			'settings_updated',
			'admin',
			'admin',
			$this->userId,
			null,
			['changes' => $changes],
		);

		return new DataResponse($this->snapshot());
	}

	/**
	 * Read the currently-persisted value for a configurable key, using the
	 * same type discipline as `persist()`. Returns null when the key has
	 * never been written — `EnsureDefaultSettings` seeds every known key on
	 * install, so this only surfaces if an admin manually nuked one.
	 */
	private function readCurrentValue(string $key): int|string|bool|null {
		$app = Application::APP_ID;
		if (!$this->appConfig->hasKey($app, $key)) {
			return null;
		}
		if (isset(self::INT_RULES[$key])) {
			return $this->appConfig->getValueInt($app, $key);
		}
		if ($key === 'ws_host' || $key === 'ws_admin_host') {
			return $this->appConfig->getValueString($app, $key);
		}
		if ($key === 'restrict_to_admins' || $key === 'update_check_enabled') {
			return $this->appConfig->getValueBool($app, $key);
		}
		return null;
	}

	public function regenerateAdminSecret(): DataResponse {
		$secret = $this->secrets->rotate();
		$this->eventClient->record(
			'admin_secret_rotated',
			'admin',
			'admin',
			$this->userId,
			null,
			[],
		);
		return new DataResponse(['secret' => $secret]);
	}

	/**
	 * Ask the WebSocket daemon to exit so its supervisor restarts it. A `200`
	 * here only confirms the exit request was accepted — the daemon comes back
	 * only if it runs under a supervisor, which the frontend verifies by polling
	 * the WS status endpoint. We intentionally do *not* record an event: the
	 * daemon's event log is in-memory and the restart wipes it, so the entry
	 * would vanish the moment it's written.
	 */
	public function restartDaemon(): DataResponse {
		try {
			$this->restartClient->restart();
		} catch (DaemonRestartFailedException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_BAD_GATEWAY);
		}
		return new DataResponse(['status' => 'restart_initiated']);
	}

	/**
	 * Ask the running daemon to re-read its tunables from `IAppConfig` in place
	 * (no restart, no reconnect). Unlike a restart this does *not* wipe the
	 * daemon's in-memory event log, so recording the action is meaningful.
	 * Binding changes aren't applied by a reload — those still need a restart.
	 */
	public function reloadDaemon(): DataResponse {
		try {
			$changed = $this->reloadClient->reload();
		} catch (DaemonReloadFailedException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_BAD_GATEWAY);
		}
		$this->eventClient->record(
			'daemon_config_reloaded',
			'admin',
			'admin',
			$this->userId,
			null,
			['changed' => array_keys($changed)],
		);
		return new DataResponse(['status' => 'reloaded', 'changed' => $changed]);
	}

	/**
	 * Run an on-demand GitHub release check and return the resulting update
	 * status. The check is best-effort — a network failure leaves the cached
	 * status untouched and still returns `200`, because "couldn't reach GitHub
	 * right now" is not an admin-actionable error. Ignores the
	 * `update_check_enabled` toggle: an explicit click is itself consent.
	 */
	public function checkForUpdates(): DataResponse {
		return new DataResponse($this->updateChecker->check());
	}

	/**
	 * Admin-gated SSE proxy onto the daemon's cross-room event feed. Same
	 * shape as `RoomController::eventsStream` but talks to
	 * `AdminEventClient::streamGlobal` and is gated by Nextcloud's default
	 * admin middleware (no `#[NoAdminRequired]`).
	 *
	 * `Last-Event-ID` rides via the standard SSE header on automatic
	 * reconnect, with `?lastEventId=` as a fallback for hand-rolled callers.
	 */
	#[NoCSRFRequired]
	public function eventsStream(): Response {
		$lastEventId = $this->parseClientLastEventId();
		$client = $this->eventClient;

		return new SseStreamResponse(static function () use ($client, $lastEventId): void {
			$aborted = false;
			$client->streamGlobal($lastEventId, static function (string $chunk) use (&$aborted): int {
				if ($aborted) {
					return 0;
				}
				echo $chunk;
				@ob_flush();
				@flush();
				if (connection_aborted()) {
					$aborted = true;
					return 0;
				}
				return strlen($chunk);
			});
		});
	}

	/**
	 * Read the SSE replay cursor from the incoming request. EventSource sends
	 * `Last-Event-ID` on automatic reconnect; we also accept `?lastEventId=`
	 * for hand-rolled callers and tests.
	 */
	private function parseClientLastEventId(): ?int {
		$headerValue = $this->request->getHeader('Last-Event-ID');
		if ($headerValue !== '' && ctype_digit($headerValue)) {
			return (int)$headerValue;
		}
		$query = $this->request->getParam('lastEventId');
		if (is_string($query) && ctype_digit($query)) {
			return (int)$query;
		}
		if (is_int($query)) {
			return $query;
		}
		return null;
	}

	/**
	 * Build the snapshot returned to the admin UI. Each configurable value is
	 * the *persisted* value or `null` when the key has never been written —
	 * never an in-code fallback. The frontend renders `null` as an empty input
	 * with a placeholder suggesting the install-time default. In practice
	 * every key is seeded by `EnsureDefaultSettings`, so nulls only appear if
	 * an admin manually deleted a key via `occ config:app:delete`.
	 *
	 * @return array{
	 *     wsTuning: array<string, int|null>,
	 *     daemon: array{ws_host: string|null, ws_port: int|null, ws_admin_host: string|null, ws_admin_port: int|null},
	 *     rooms: array{restrict_to_admins: bool|null, default_ttl_seconds: int|null, max_ttl_seconds: int|null, max_clients_per_room: int|null},
	 *     secret: array{configured: bool, masked: string, length: int},
	 *     updates: array{enabled: bool, currentVersion: string, latestVersion: ?string, updateAvailable: bool, releaseUrl: string, lastCheckedAt: ?int}
	 * }
	 */
	private function snapshot(): array {
		$readInt = fn (string $k) => $this->readPersistedInt($k);
		$readStr = fn (string $k) => $this->readPersistedString($k);

		return [
			'wsTuning' => [
				'ws_join_timeout_ms' => $readInt('ws_join_timeout_ms'),
				'ws_idle_close_ms' => $readInt('ws_idle_close_ms'),
				'ws_tombstone_ms' => $readInt('ws_tombstone_ms'),
				'ws_kick_block_ms' => $readInt('ws_kick_block_ms'),
				'ws_event_log_size' => $readInt('ws_event_log_size'),
				'ws_rate_limit_events_per_sec' => $readInt('ws_rate_limit_events_per_sec'),
				'ws_drift_nudge_threshold_ms' => $readInt('ws_drift_nudge_threshold_ms'),
				'ws_drift_seek_threshold_ms' => $readInt('ws_drift_seek_threshold_ms'),
				'ws_drift_cooldown_ms' => $readInt('ws_drift_cooldown_ms'),
			],
			'daemon' => [
				'ws_host' => $readStr('ws_host'),
				'ws_port' => $readInt('ws_port'),
				'ws_admin_host' => $readStr('ws_admin_host'),
				'ws_admin_port' => $readInt('ws_admin_port'),
			],
			'rooms' => [
				'restrict_to_admins' => $this->readPersistedBool('restrict_to_admins'),
				'default_ttl_seconds' => $readInt('default_ttl_seconds'),
				'max_ttl_seconds' => $readInt('max_ttl_seconds'),
				'max_clients_per_room' => $readInt('max_clients_per_room'),
			],
			'secret' => $this->secrets->peekMasked(),
			'updates' => $this->updateChecker->status(),
		];
	}

	private function readPersistedInt(string $key): ?int {
		$app = Application::APP_ID;
		if (!$this->appConfig->hasKey($app, $key)) {
			return null;
		}
		return $this->appConfig->getValueInt($app, $key);
	}

	private function readPersistedString(string $key): ?string {
		$app = Application::APP_ID;
		if (!$this->appConfig->hasKey($app, $key)) {
			return null;
		}
		return $this->appConfig->getValueString($app, $key);
	}

	private function readPersistedBool(string $key): ?bool {
		$app = Application::APP_ID;
		if (!$this->appConfig->hasKey($app, $key)) {
			return null;
		}
		return $this->appConfig->getValueBool($app, $key);
	}

	/**
	 * @param array<string, mixed> $values
	 * @return array<string, int|string|bool>
	 * @throws \InvalidArgumentException on any unknown key, type mismatch, or out-of-range value.
	 */
	private function validate(array $values): array {
		$out = [];
		foreach ($values as $key => $value) {
			if (isset(self::INT_RULES[$key])) {
				$normalized = $this->coerceInt($key, $value);
				$rule = self::INT_RULES[$key];
				if ($normalized < $rule['min'] || $normalized > $rule['max']) {
					throw new \InvalidArgumentException(
						sprintf('%s must be between %d and %d.', $key, $rule['min'], $rule['max']),
					);
				}
				$out[$key] = $normalized;
				continue;
			}

			if ($key === 'ws_host' || $key === 'ws_admin_host') {
				if (!is_string($value)) {
					throw new \InvalidArgumentException($key . ' must be a string.');
				}
				$trimmed = trim($value);
				if ($trimmed === '' || mb_strlen($trimmed) > 255 || preg_match(self::HOST_REGEX, $trimmed) !== 1) {
					throw new \InvalidArgumentException($key . ' must be a valid hostname or IP literal.');
				}
				$out[$key] = $trimmed;
				continue;
			}

			if ($key === 'restrict_to_admins' || $key === 'update_check_enabled') {
				if (!is_bool($value)) {
					throw new \InvalidArgumentException($key . ' must be a boolean.');
				}
				$out[$key] = $value;
				continue;
			}

			throw new \InvalidArgumentException('Unknown setting: ' . $key);
		}
		return $out;
	}

	private function coerceInt(string $key, mixed $value): int {
		if (is_int($value)) {
			return $value;
		}
		// Accept numeric strings ("8765") because <input type="number"> can
		// serialize that way over JSON in some clients, but reject anything
		// that isn't a clean integer literal.
		if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) {
			return (int)$value;
		}
		throw new \InvalidArgumentException($key . ' must be an integer.');
	}

	private function persist(string $key, int|string|bool $value): void {
		$app = Application::APP_ID;
		if (is_int($value)) {
			$this->appConfig->setValueInt($app, $key, $value);
			return;
		}
		if (is_bool($value)) {
			$this->appConfig->setValueBool($app, $key, $value);
			return;
		}
		$this->appConfig->setValueString($app, $key, $value);
	}
}
