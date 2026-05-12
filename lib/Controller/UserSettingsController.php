<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IConfig;
use OCP\IRequest;

/**
 * Per-user personal settings REST surface. Every action is open to any
 * logged-in user via `#[NoAdminRequired]`; CSRF middleware stays on by
 * default. The values are stored under the user's own `userValue` namespace
 * (`IConfig::setUserValue`) so they sync across devices.
 */
class UserSettingsController extends Controller {

	/**
	 * Inclusive numeric validation rules.
	 *
	 * @var array<string, array{min: int, max: int}>
	 */
	private const INT_RULES = [
		'auto_refresh_interval_ms' => ['min' => 2_000, 'max' => 600_000],
	];

	/**
	 * @var array<string, int>
	 */
	private const INT_DEFAULTS = [
		'auto_refresh_interval_ms' => 15_000,
	];

	public function __construct(
		string $appName,
		IRequest $request,
		private readonly ?string $userId,
		private readonly IConfig $config,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}
		return new DataResponse($this->snapshot($this->userId));
	}

	/**
	 * Persist a partial patch of user settings. The payload is a flat map
	 * keyed by config key; unknown keys and out-of-range values are rejected
	 * with `400 Bad Request` and no values are written.
	 *
	 * @param array<string, mixed> $values flat config-key → new-value map.
	 */
	#[NoAdminRequired]
	public function update(array $values = []): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$normalized = $this->validate($values);
		} catch (\InvalidArgumentException $e) {
			return new DataResponse(['error' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}

		foreach ($normalized as $key => $value) {
			$this->persist($this->userId, $key, $value);
		}

		return new DataResponse($this->snapshot($this->userId));
	}

	/**
	 * Build the snapshot returned to the client. Keys are camelCased for the
	 * frontend payload while the underlying config keys stay snake_case to
	 * match the rest of the app's config conventions.
	 *
	 * @param string $userId the UID whose user values to read
	 * @return array{autoRefreshIntervalMs: int}
	 */
	private function snapshot(string $userId): array {
		return [
			'autoRefreshIntervalMs' => $this->readInt($userId, 'auto_refresh_interval_ms'),
		];
	}

	/**
	 * Validate a partial patch. Reject unknown keys, non-integer values, and
	 * values outside their configured range.
	 *
	 * @param array<string, mixed> $values
	 * @return array<string, int> normalized integer values keyed by config key
	 * @throws \InvalidArgumentException on any unknown key, type mismatch, or out-of-range value.
	 */
	private function validate(array $values): array {
		$out = [];
		foreach ($values as $key => $value) {
			if (!isset(self::INT_RULES[$key])) {
				throw new \InvalidArgumentException('Unknown setting: ' . $key);
			}
			$normalized = $this->coerceInt($key, $value);
			$rule = self::INT_RULES[$key];
			if ($normalized < $rule['min'] || $normalized > $rule['max']) {
				throw new \InvalidArgumentException(
					sprintf('%s must be between %d and %d.', $key, $rule['min'], $rule['max']),
				);
			}
			$out[$key] = $normalized;
		}
		return $out;
	}

	private function coerceInt(string $key, mixed $value): int {
		if (is_int($value)) {
			return $value;
		}
		// Accept numeric strings ("15000") because <input type="number"> can
		// serialize that way over JSON in some clients, but reject anything
		// that isn't a clean integer literal.
		if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) {
			return (int)$value;
		}
		throw new \InvalidArgumentException($key . ' must be an integer.');
	}

	private function readInt(string $userId, string $key): int {
		$raw = $this->config->getUserValue(
			$userId,
			Application::APP_ID,
			$key,
			(string)self::INT_DEFAULTS[$key],
		);
		// IConfig::getUserValue always returns a string; normalize back to int.
		// A malformed stored value (e.g. left over from a prior version) falls
		// back to the default so the UI never receives garbage.
		if (preg_match('/^-?\d+$/', $raw) !== 1) {
			return self::INT_DEFAULTS[$key];
		}
		return (int)$raw;
	}

	private function persist(string $userId, string $key, int $value): void {
		$this->config->setUserValue($userId, Application::APP_ID, $key, (string)$value);
	}
}
