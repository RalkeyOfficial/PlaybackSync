<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\AdminSecretService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
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

	/**
	 * @var array<string, int>
	 */
	private const INT_DEFAULTS = [
		'ws_join_timeout_ms' => 5_000,
		'ws_idle_close_ms' => 30_000,
		'ws_tombstone_ms' => 30_000,
		'ws_kick_block_ms' => 30_000,
		'ws_event_log_size' => 200,
		'ws_rate_limit_events_per_sec' => 10,
		'ws_drift_nudge_threshold_ms' => 200,
		'ws_drift_seek_threshold_ms' => 500,
		'ws_drift_cooldown_ms' => 3_000,
		'ws_port' => 8765,
		'ws_admin_port' => 8766,
		'default_ttl_seconds' => 86_400,
		'max_ttl_seconds' => 86_400,
		'max_clients_per_room' => 50,
	];

	/**
	 * @var array<string, string>
	 */
	private const STRING_DEFAULTS = [
		'ws_host' => '127.0.0.1',
		'ws_admin_host' => '127.0.0.1',
	];

	private const HOST_REGEX = '/^[A-Za-z0-9._:\-]+$/';

	public function __construct(
		string $appName,
		IRequest $request,
		private readonly IAppConfig $appConfig,
		private readonly AdminSecretService $secrets,
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
			?? $this->appConfig->getValueInt(Application::APP_ID, 'max_ttl_seconds', self::INT_DEFAULTS['max_ttl_seconds']);
		$effectiveDefault = $normalized['default_ttl_seconds']
			?? $this->appConfig->getValueInt(Application::APP_ID, 'default_ttl_seconds', self::INT_DEFAULTS['default_ttl_seconds']);
		if ($effectiveDefault > $effectiveMax) {
			return new DataResponse(
				['error' => 'default_ttl_seconds must not exceed max_ttl_seconds.'],
				Http::STATUS_BAD_REQUEST,
			);
		}

		foreach ($normalized as $key => $value) {
			$this->persist($key, $value);
		}

		return new DataResponse($this->snapshot());
	}

	public function regenerateAdminSecret(): DataResponse {
		$secret = $this->secrets->rotate();
		return new DataResponse(['secret' => $secret]);
	}

	/**
	 * @return array{
	 *     wsTuning: array<string, int>,
	 *     daemon: array{ws_host: string, ws_port: int, ws_admin_host: string, ws_admin_port: int},
	 *     rooms: array{restrict_to_admins: bool, default_ttl_seconds: int, max_ttl_seconds: int, max_clients_per_room: int},
	 *     secret: array{configured: bool, masked: string, length: int}
	 * }
	 */
	private function snapshot(): array {
		$app = Application::APP_ID;
		$readInt = fn (string $k) => $this->appConfig->getValueInt($app, $k, self::INT_DEFAULTS[$k]);
		$readStr = fn (string $k) => $this->appConfig->getValueString($app, $k, self::STRING_DEFAULTS[$k]);

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
				'restrict_to_admins' => $this->appConfig->getValueBool($app, 'restrict_to_admins', false),
				'default_ttl_seconds' => $readInt('default_ttl_seconds'),
				'max_ttl_seconds' => $readInt('max_ttl_seconds'),
				'max_clients_per_room' => $readInt('max_clients_per_room'),
			],
			'secret' => $this->secrets->peekMasked(),
		];
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

			if ($key === 'restrict_to_admins') {
				if (!is_bool($value)) {
					throw new \InvalidArgumentException('restrict_to_admins must be a boolean.');
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
