<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when a merge would exceed the per-message cap (200), the per-room
 * cap (1000), or the freeform auto-append cap (default 100, configurable).
 * Carries the cap code so the wire layer can forward it as `per_message_cap`,
 * `playlist_cap_exceeded`, or `freeform_cap_full`.
 */
class PlaylistCapExceededException extends \RuntimeException {

	public const CODE_PER_MESSAGE = 'per_message_cap';
	public const CODE_PER_ROOM = 'playlist_cap_exceeded';
	public const CODE_FREEFORM_CAP = 'freeform_cap_full';

	public function __construct(
		public readonly string $capCode,
		string $message,
	) {
		parent::__construct($message);
	}
}
