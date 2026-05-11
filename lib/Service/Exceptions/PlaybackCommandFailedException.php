<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when the loopback admin call to send a playback command failed for
 * an operational reason — daemon down, HMAC misconfigured, network error, or
 * a non-200/404/400 response. Distinct from `RoomNotLiveException`, which
 * means the daemon authoritatively reported no live runtime for the room.
 */
class PlaybackCommandFailedException extends \RuntimeException {
}
