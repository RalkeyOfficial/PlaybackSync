<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\IAppConfig;

/**
 * Owner of the WebSocket daemon's admin shared secret.
 *
 * Generation, masked exposure, and rotation all live here so the migration
 * repair-step (`EnsureAdminSecret`) and the admin settings UI share a single
 * source of truth. The plaintext secret never leaves this class — callers
 * that need to display it to an admin get a masked form via `peekMasked()`.
 */
class AdminSecretService {

	public const KEY = 'ws_admin_secret';

	public function __construct(
		private readonly IAppConfig $appConfig,
	) {
	}

	/**
	 * Return a fresh 256-bit hex secret. Caller is responsible for persisting
	 * it via `IAppConfig::setValueString(..., sensitive: true)` or, more
	 * conveniently, by calling `rotate()`.
	 */
	public function generate(): string {
		return bin2hex(random_bytes(32));
	}

	/**
	 * @return array{configured: bool, masked: string, length: int}
	 */
	public function peekMasked(): array {
		$current = $this->appConfig->getValueString(Application::APP_ID, self::KEY, '');
		if ($current === '') {
			return ['configured' => false, 'masked' => '', 'length' => 0];
		}
		return [
			'configured' => true,
			'masked' => $this->mask($current),
			'length' => strlen($current),
		];
	}

	/**
	 * Generate a new secret, persist it, and return the masked form.
	 *
	 * @return array{configured: true, masked: string, length: int}
	 */
	public function rotate(): array {
		$secret = $this->generate();
		$this->appConfig->setValueString(
			Application::APP_ID,
			self::KEY,
			$secret,
			lazy: false,
			sensitive: true,
		);
		return [
			'configured' => true,
			'masked' => $this->mask($secret),
			'length' => strlen($secret),
		];
	}

	/**
	 * Set the secret only when one isn't already configured. Used by the
	 * idempotent install/upgrade repair step.
	 *
	 * @return bool true when a new secret was generated, false when one already existed.
	 */
	public function ensureExists(): bool {
		$current = $this->appConfig->getValueString(Application::APP_ID, self::KEY, '');
		if ($current !== '') {
			return false;
		}
		$this->appConfig->setValueString(
			Application::APP_ID,
			self::KEY,
			$this->generate(),
			lazy: false,
			sensitive: true,
		);
		return true;
	}

	private function mask(string $secret): string {
		// Show only the first and last 4 chars; never enough to brute-force,
		// but enough for an admin to recognise it across rotations.
		if (strlen($secret) <= 8) {
			return str_repeat('•', strlen($secret));
		}
		return substr($secret, 0, 4) . '…' . substr($secret, -4);
	}
}
