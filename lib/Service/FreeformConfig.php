<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\IAppConfig;

/**
 * Tunables that apply to freeform-mode rooms specifically.
 *
 * Kept out of `WsConfig` because freeform behaviour is enforced in the
 * service layer (shared between WS handlers and HTTP controllers), not
 * exclusively inside the daemon.
 */
class FreeformConfig {
	public function __construct(
		public readonly int $autoAppendCap,
	) {
	}

	public static function fromAppConfig(IAppConfig $cfg): self {
		$raw = $cfg->getValueInt(Application::APP_ID, 'freeform_auto_append_cap', 100);
		// Clamp to a sane range. The lower bound prevents zero / negative caps
		// from making the room immediately reject every auto-append; the upper
		// bound matches `PlaylistService::PER_ROOM_CAP` so the freeform cap can
		// never exceed the global ceiling.
		$clamped = max(1, min($raw, PlaylistService::PER_ROOM_CAP));
		return new self(autoAppendCap: $clamped);
	}
}
