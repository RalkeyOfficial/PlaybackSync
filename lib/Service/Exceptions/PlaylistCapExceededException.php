<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when a merge would exceed either the per-message cap (200) or
 * the per-room cap (1000). Carries the cap code so the wire layer can
 * forward it as `per_message_cap` or `playlist_cap_exceeded`.
 */
class PlaylistCapExceededException extends \RuntimeException {

	public const CODE_PER_MESSAGE = 'per_message_cap';
	public const CODE_PER_ROOM = 'playlist_cap_exceeded';

	public function __construct(
		public readonly string $capCode,
		string $message,
	) {
		parent::__construct($message);
	}
}
